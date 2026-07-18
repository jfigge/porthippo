/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * engine.js — the single `TunnelEngine` that owns every live tunnel.
 *
 * It holds a `Map<id, Tunnel>`, reads definitions (decrypted, in-process) from the
 * Feature 10 store, builds each hop's host-key verifier against the accepted-keys
 * store + `~/.ssh/known_hosts`, and mediates host-key trust prompts between the
 * verifier and the renderer. State changes and host-key events are pushed to the
 * renderer through an injected `broadcast(channel, payload)` so this module never
 * imports Electron and stays testable headless.
 *
 * Wiring lives in main.js: instantiate once, `armAll()` on startup, `reconcile(id)`
 * after every store write, and `disarmAll()` on `before-quit`.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");

const { Tunnel } = require("./tunnel");
const { makeHostVerifier } = require("./host-verifier");
const { probeChain } = require("./ssh-chain");

const DEFAULT_LINGER_MS = 10000;

// Reconnect-policy + keepalive defaults (Feature 130). These mirror the seeds in
// settings-store's DEFAULTS and the fallbacks in tunnel.js; they only apply when
// the settings store can't be read (pre-store / error), so the engine never hands
// the tunnel a broken policy.
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 6;
const DEFAULT_SSH_KEEPALIVE_SECONDS = 15;

// A resolution probe (Feature 100) is time-boxed so a black-holed hop can't hang the
// editor's "Test resolution" spinner forever; the run aborts and reports the reach.
const PROBE_TIMEOUT_MS = 20000;

// The `jumphippo:stats` heartbeat: one throttled snapshot of every tunnel, on a
// timer while any tunnel is armed. State changes also emit an immediate snapshot,
// so this only backstops steady-state rate/uptime updates between transitions.
const STATS_INTERVAL_MS = 1000;

class TunnelEngine {
  #getStores;
  #broadcast;
  #knownHostsFile;
  #getManagedIds;
  #keyReader;

  #tunnels = new Map();
  #prompts = new Map(); // promptId → { resolve } for pending host-key decisions
  #statsTimer = null; // the throttled jumphippo:stats heartbeat (null when idle)
  // Feature 140 — bulk-action coalescing. While `applyToMany` runs, this is a
  // `Map<id, snapshot>` (last-wins) that collects each tunnel's state change
  // instead of broadcasting it, so the whole set produces ONE trailing
  // `jumphippo:tunnel-state` broadcast rather than one message per tunnel.
  #batch = null;

  /**
   * @param {object} deps
   * @param {() => import('../store/stores').Stores} deps.getStores
   * @param {(channel: string, payload: object) => void} [deps.broadcast]
   * @param {string} [deps.knownHostsFile]  override the OpenSSH known_hosts path
   *        (defaults to the user's `~/.ssh/known_hosts`); used by tests.
   * @param {() => Set<string>} [deps.getManagedIds]  the ids currently owned by the
   *        Feature 150 scheduler. `reconcile`/`reconcileAll` never arm these — their
   *        armed state is the scheduler's to own — so a store write / unlock can't
   *        arm a tunnel the schedule wants disarmed. Defaults to "none managed".
   * @param {typeof import('fs').readFileSync} [deps.keyReader]  the `readFileSync`-
   *        shaped reader used for every private-key read (Feature 190). On the Mac
   *        App Store main injects a security-scoped-bookmark reader here; everywhere
   *        else it's a plain `fs.readFileSync` (the default). Threaded into each
   *        Tunnel as `readFileSync` — the same seam the tests inject a fake through
   *        — so the engine never imports Electron.
   */
  constructor({
    getStores,
    broadcast,
    knownHostsFile,
    getManagedIds,
    keyReader,
  }) {
    this.#getStores = getStores;
    this.#broadcast = broadcast;
    this.#knownHostsFile = knownHostsFile;
    this.#getManagedIds = getManagedIds || (() => new Set());
    this.#keyReader = keyReader || fs.readFileSync;
  }

  /** The scheduler-managed id set, coerced + fail-safe to empty. */
  #managedIds() {
    try {
      const set = this.#getManagedIds();
      return set instanceof Set ? set : new Set(set || []);
    } catch {
      return new Set();
    }
  }

  // ── Public control surface (IPC-facing; these never throw for expected cases) ──

  /** Arm a definition by id: (re)bind its listener, connecting SSH lazily. */
  async arm(id) {
    const def = this.#getStores().tunnelStore().getDecrypted(id);
    if (!def) return { id, state: "disarmed", error: "definition not found" };

    let tunnel = this.#tunnels.get(id);
    // Already actively armed → return its status. But an `error` tunnel (e.g. a
    // transient bind conflict like EADDRINUSE) is re-armable: fall through to
    // dispose + re-make it, exactly like `disarmed`, so a retry can recover
    // rather than the short-circuit turning arm() into a permanent no-op.
    if (tunnel && tunnel.state !== "disarmed" && tunnel.state !== "error")
      return tunnel.status();
    if (tunnel) await tunnel.dispose();

    tunnel = this.#makeTunnel(def);
    this.#tunnels.set(id, tunnel);
    return tunnel.arm();
  }

  /** Disarm a definition: tear down SSH + listener, keep the definition. */
  async disarm(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return { id, state: "disarmed" };
    return tunnel.disarm();
  }

  /** Force-apply a pending edit now, dropping any live connections. */
  async apply(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return { id, state: "disarmed" };
    await tunnel.forceApply(); // await the teardown+re-arm so status is current
    return tunnel.status();
  }

  /** Pause a tunnel: freeze traffic + stop accepting, keeping SSH alive. */
  pause(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return { id, state: "disarmed" };
    return tunnel.pause();
  }

  /** Resume a paused tunnel: re-accept and un-freeze its relays. */
  resume(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return { id, state: "disarmed" };
    return tunnel.resume();
  }

  /**
   * Apply one action to a set of tunnels (Feature 140 bulk actions / group
   * arm-all). `action` is one of `arm` / `disarm` / `pause` / `resume`; it delegates
   * to the matching per-tunnel method for each id, best-effort (one failure never
   * aborts the sweep), then emits a SINGLE coalesced `jumphippo:tunnel-state`
   * broadcast (array payload) plus one stats refresh — never one message per tunnel.
   * The engine stays group-unaware: "arm this group" is just the group's member ids.
   *
   * @param {string[]} ids
   * @param {"arm"|"disarm"|"pause"|"resume"} action
   * @returns {Promise<object[]>}  the affected tunnels' final snapshots
   */
  async applyToMany(ids, action) {
    const ACTIONS = new Set(["arm", "disarm", "pause", "resume"]);
    if (!ACTIONS.has(action)) {
      const err = new Error(`unknown bulk action: ${action}`);
      err.code = "INVALID_ARG";
      throw err;
    }

    const unique = [...new Set(Array.isArray(ids) ? ids : [])];
    // Per-id try/catch means the loop below can never throw, so #batch is always
    // cleared and the trailing broadcast always fires (no try/finally needed).
    this.#batch = new Map();
    for (const id of unique) {
      try {
        await this[action](id);
      } catch (err) {
        console.error(
          `[engine] applyToMany ${action} ${id} failed:`,
          err && err.message,
        );
      }
    }
    const snapshots = [...this.#batch.values()];
    this.#batch = null;

    // One coalesced state broadcast for the whole set, then one stats refresh.
    this.#broadcast?.("jumphippo:tunnel-state", snapshots);
    this.#onTunnelStateChange();
    return snapshots;
  }

  /** Snapshot of every tracked tunnel's state. */
  status() {
    return [...this.#tunnels.values()].map((t) => t.status());
  }

  /**
   * The error/warning event log for one tunnel (oldest first), or `[]` when the
   * tunnel isn't currently held by the engine. Read on demand when the user opens
   * the "Errors" card, so the frequent stats heartbeat stays lean.
   */
  events(id) {
    return this.#tunnels.get(id)?.events() ?? [];
  }

  /**
   * Arm every enabled definition (startup). An optional `skip` set of ids is left
   * untouched — the caller uses it to hand those ids to another owner (Feature 150
   * hands scheduled tunnels to the scheduler); the engine stays unaware of *why*.
   *
   * @param {object} [opts]
   * @param {Set<string>} [opts.skip]
   */
  async armAll({ skip } = {}) {
    const defs = this.#getStores().tunnelStore().listDecrypted();
    for (const def of defs) {
      if (!def.enabled) continue;
      if (skip && skip.has(def.id)) continue;
      try {
        await this.arm(def.id);
      } catch (err) {
        console.error(`[engine] arm ${def.id} failed:`, err && err.message);
      }
    }
  }

  /** Dispose every tunnel and reject pending prompts (app quit). */
  async disarmAll() {
    const tunnels = [...this.#tunnels.values()];
    this.#tunnels.clear();
    this.#stopStatsTimer(); // dispose() doesn't emit, so stop the heartbeat here
    await Promise.all(tunnels.map((t) => t.dispose().catch(() => {})));
    for (const { resolve } of this.#prompts.values()) resolve(false);
    this.#prompts.clear();
  }

  /**
   * Re-read a definition after a store write and reconcile the running tunnel:
   * deleted → dispose; new + enabled → arm; existing → apply the edit in place
   * (idle re-arm now, active → pending); newly enabled while disarmed → arm.
   *
   * A tunnel the scheduler MANAGES (Feature 150) is never armed here — its armed
   * state belongs to the scheduler — so this applies edits / disposal but leaves
   * arming to it. Every caller (store afterWrite, refs write, import, unlock,
   * reconcileAll) gets this for free via the injected managed-id set.
   *
   * @param {string} id
   * @param {Set<string>} [managed]  the scheduler-managed ids (computed if absent)
   */
  async reconcile(id, managed) {
    const m = managed || this.#managedIds();
    const def = this.#getStores().tunnelStore().getDecrypted(id);
    const tunnel = this.#tunnels.get(id);

    if (!def) {
      if (tunnel) {
        await tunnel.dispose();
        this.#tunnels.delete(id);
        this.#broadcast?.("jumphippo:tunnel-state", {
          id,
          state: "disarmed",
          removed: true,
        });
        this.#onTunnelStateChange(); // drop from the stats heartbeat
      }
      return;
    }

    if (!tunnel) {
      if (def.enabled && !m.has(id)) await this.arm(id);
      return;
    }

    tunnel.applyDefinition(def);
    if (def.enabled && tunnel.state === "disarmed" && !m.has(id)) {
      await tunnel.arm();
    }
  }

  /**
   * Reconcile every definition. Used after a secret-storage unlock or mode switch
   * so tunnels that armed while a secret was undecryptable (locked master key)
   * re-read the now-decryptable definition and can (re)connect on next access.
   * Best-effort per tunnel: one failure never aborts the sweep.
   */
  async reconcileAll() {
    const managed = this.#managedIds(); // compute once for the whole sweep
    const defs = this.#getStores().tunnelStore().list();
    for (const def of defs) {
      try {
        await this.reconcile(def.id, managed);
      } catch (err) {
        console.error(
          `[engine] reconcile ${def.id} failed:`,
          err && err.message,
        );
      }
    }
  }

  // ── Resolution probe (Feature 100) ────────────────────────────────────────────

  /**
   * Test-resolve an (already engine-shaped, decrypted) definition through its real
   * chain: connect each hop from its correct vantage point and probe the destination
   * from the SSH server, reporting a per-hop result. It reuses the same host-key
   * verifier as `arm()`, so an unknown key prompts (and is persisted on trust) here
   * too — but it NEVER binds a listener, touches `#tunnels`, or leaves a connection
   * open: every hop is disposed on success, failure, cancel, and timeout.
   *
   * @param {object} def  engine-shaped `{ destination, sshServer, jumps }`
   * @param {object} [opts]
   * @param {AbortSignal} [opts.signal]  cancel the in-flight probe
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<object>}  `{ ok, hops[], destination }`
   */
  async probeDefinition(def, { signal, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const d = def || {};
    // Fold the caller's signal and an internal timeout into one abort source.
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      // Only local forwarding has a far-end destination to probe. A remote tunnel's
      // destination is a LOCAL target (unreachable from the far end) and a dynamic
      // tunnel has none, so for those we validate the chain only.
      const probeDest =
        (d.type || "local") === "local" ? d.destination || {} : {};
      return await probeChain({
        hops: [...(Array.isArray(d.jumps) ? d.jumps : []), d.sshServer],
        destination: probeDest,
        tunnelId: d.id || "probe",
        hostVerifierFactory: (ctx) => this.#buildHostVerifier(ctx),
        // Read key-auth hops through the same injected reader as a real connect,
        // so a "Test resolution" on MAS uses the security-scoped bookmark too.
        readFileSync: this.#keyReader,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  // ── Host-key trust decisions (resolve a pending verifier prompt) ──────────────

  /** Resolve an unknown-host-key prompt as trusted. */
  trustHostKey(promptId) {
    return this.#resolvePrompt(promptId, true);
  }

  /** Resolve an unknown-host-key prompt as rejected. */
  rejectHostKey(promptId) {
    return this.#resolvePrompt(promptId, false);
  }

  #resolvePrompt(promptId, accepted) {
    const prompt = this.#prompts.get(promptId);
    if (!prompt) return { ok: false, promptId };
    this.#prompts.delete(promptId);
    prompt.resolve(accepted);
    return { ok: true, promptId, accepted };
  }

  // ── Internal wiring ───────────────────────────────────────────────────────────

  #makeTunnel(def) {
    return new Tunnel(def, {
      hostVerifierFactory: (ctx) => this.#buildHostVerifier(ctx),
      // Feature 190: every key read goes through the injected reader (a plain
      // fs.readFileSync off MAS; a bookmark-bracketing reader on the Mac App Store).
      readFileSync: this.#keyReader,
      getLingerMs: (d) => this.#effectiveLinger(d),
      // Feature 130 — reconnect policy (settings + per-tunnel override) and the
      // SSH-layer keepalive interval, both read live so a settings edit lands on
      // the next reconnect / connect without re-arming.
      getRetryPolicy: (d) => this.#effectiveRetry(d),
      getSshKeepaliveMs: () => this.#sshKeepaliveMs(),
      onStateChange: (snapshot) => {
        // During a bulk action, collect the snapshot (last state wins per id) so
        // the whole set coalesces into one broadcast; otherwise emit immediately.
        if (this.#batch) {
          this.#batch.set(snapshot.id, snapshot);
          return;
        }
        this.#broadcast?.("jumphippo:tunnel-state", snapshot);
        this.#onTunnelStateChange();
      },
    });
  }

  #settings() {
    try {
      return this.#getStores().settingsStore().get();
    } catch {
      return {};
    }
  }

  /**
   * The effective reconnect policy for a def: the global settings seeds, then any
   * per-tunnel `retry` override (each field independent). Sanitised so a corrupt
   * value can never hand the tunnel a non-positive backoff.
   */
  #effectiveRetry(def) {
    const s = this.#settings();
    const intOr = (v, dflt, min) =>
      Number.isInteger(v) && v >= min ? v : dflt;
    const policy = {
      baseMs: intOr(s.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS, 1),
      maxMs: intOr(s.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, 1),
      maxAttempts: intOr(
        s.reconnectMaxAttempts,
        DEFAULT_RECONNECT_MAX_ATTEMPTS,
        0,
      ),
    };
    const o = def && def.retry;
    if (o && typeof o === "object") {
      if (Number.isInteger(o.baseMs) && o.baseMs >= 1) policy.baseMs = o.baseMs;
      if (Number.isInteger(o.maxMs) && o.maxMs >= 1) policy.maxMs = o.maxMs;
      if (Number.isInteger(o.maxAttempts) && o.maxAttempts >= 0) {
        policy.maxAttempts = o.maxAttempts;
      }
    }
    return policy;
  }

  /** The SSH keepalive probe interval in ms (0 = off). */
  #sshKeepaliveMs() {
    const s = this.#settings();
    const secs = Number.isFinite(Number(s.sshKeepaliveSeconds))
      ? Number(s.sshKeepaliveSeconds)
      : DEFAULT_SSH_KEEPALIVE_SECONDS;
    return secs > 0 ? Math.round(secs * 1000) : 0;
  }

  // ── Stats heartbeat (Feature 30) ──────────────────────────────────────────────
  // One throttled `jumphippo:stats` snapshot of every tunnel, plus an immediate
  // snapshot on any state change so the UI reflects connect/disconnect/pause
  // without waiting up to a second. No per-byte or per-connection IPC.

  /** A tunnel changed state: (re)evaluate the heartbeat and push a snapshot now. */
  #onTunnelStateChange() {
    this.#refreshStatsTimer();
    this.#emitStats();
  }

  /** Collect every tunnel's stats snapshot and broadcast it in one message. */
  #emitStats() {
    const snapshots = [...this.#tunnels.values()].map((t) => t.statsSnapshot());
    this.#broadcast?.("jumphippo:stats", snapshots);
  }

  /** Run the heartbeat while ≥1 tunnel is live; stop it once all are quiescent. */
  #refreshStatsTimer() {
    const anyLive = [...this.#tunnels.values()].some(
      (t) => t.state !== "disarmed" && t.state !== "error",
    );
    if (anyLive && !this.#statsTimer) {
      this.#statsTimer = setInterval(
        () => this.#emitStats(),
        STATS_INTERVAL_MS,
      );
      this.#statsTimer.unref?.(); // never keep the process alive for the heartbeat
    } else if (!anyLive) {
      this.#stopStatsTimer();
    }
  }

  #stopStatsTimer() {
    if (this.#statsTimer) {
      clearInterval(this.#statsTimer);
      this.#statsTimer = null;
    }
  }

  #buildHostVerifier(ctx) {
    return makeHostVerifier({
      ...ctx, // host, port, hopLabel, tunnelId
      knownHostsStore: this.#getStores().knownHostsStore(),
      knownHostsFile: this.#knownHostsFile,
      requestTrust: (info) => this.#requestTrust(info),
      reportChanged: (info) =>
        this.#broadcast?.("jumphippo:hostkey-changed", info),
    });
  }

  /** Emit an unknown-host-key prompt and return a promise resolved by the user. */
  #requestTrust(info) {
    const promptId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#prompts.set(promptId, { resolve });
      this.#broadcast?.("jumphippo:hostkey-unknown", {
        promptId,
        tunnelId: info.tunnelId,
        hop: info.hop,
        host: info.host,
        port: info.port,
        fingerprint: info.fingerprint,
      });
    });
  }

  #effectiveLinger(def) {
    if (Number.isInteger(def.lingerMs) && def.lingerMs >= 0)
      return def.lingerMs;
    try {
      const settings = this.#getStores().settingsStore().get();
      return settings.defaultLingerMs ?? DEFAULT_LINGER_MS;
    } catch {
      return DEFAULT_LINGER_MS;
    }
  }
}

module.exports = { TunnelEngine };
