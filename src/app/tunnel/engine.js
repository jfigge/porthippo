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

const { Tunnel } = require("./tunnel");
const { makeHostVerifier } = require("./host-verifier");
const { probeChain } = require("./ssh-chain");

const DEFAULT_LINGER_MS = 10000;

// A resolution probe (Feature 100) is time-boxed so a black-holed hop can't hang the
// editor's "Test resolution" spinner forever; the run aborts and reports the reach.
const PROBE_TIMEOUT_MS = 20000;

// The `porthippo:stats` heartbeat: one throttled snapshot of every tunnel, on a
// timer while any tunnel is armed. State changes also emit an immediate snapshot,
// so this only backstops steady-state rate/uptime updates between transitions.
const STATS_INTERVAL_MS = 1000;

class TunnelEngine {
  #getStores;
  #broadcast;
  #knownHostsFile;

  #tunnels = new Map();
  #prompts = new Map(); // promptId → { resolve } for pending host-key decisions
  #statsTimer = null; // the throttled porthippo:stats heartbeat (null when idle)

  /**
   * @param {object} deps
   * @param {() => import('../store/stores').Stores} deps.getStores
   * @param {(channel: string, payload: object) => void} [deps.broadcast]
   * @param {string} [deps.knownHostsFile]  override the OpenSSH known_hosts path
   *        (defaults to the user's `~/.ssh/known_hosts`); used by tests.
   */
  constructor({ getStores, broadcast, knownHostsFile }) {
    this.#getStores = getStores;
    this.#broadcast = broadcast;
    this.#knownHostsFile = knownHostsFile;
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
  apply(id) {
    const tunnel = this.#tunnels.get(id);
    if (!tunnel) return { id, state: "disarmed" };
    tunnel.forceApply();
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

  /** Snapshot of every tracked tunnel's state. */
  status() {
    return [...this.#tunnels.values()].map((t) => t.status());
  }

  /** Arm every enabled definition (startup). */
  async armAll() {
    const defs = this.#getStores().tunnelStore().listDecrypted();
    for (const def of defs) {
      if (!def.enabled) continue;
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
   */
  async reconcile(id) {
    const def = this.#getStores().tunnelStore().getDecrypted(id);
    const tunnel = this.#tunnels.get(id);

    if (!def) {
      if (tunnel) {
        await tunnel.dispose();
        this.#tunnels.delete(id);
        this.#broadcast?.("porthippo:tunnel-state", {
          id,
          state: "disarmed",
          removed: true,
        });
        this.#onTunnelStateChange(); // drop from the stats heartbeat
      }
      return;
    }

    if (!tunnel) {
      if (def.enabled) await this.arm(id);
      return;
    }

    tunnel.applyDefinition(def);
    if (def.enabled && tunnel.state === "disarmed") await tunnel.arm();
  }

  /**
   * Reconcile every definition. Used after a secret-storage unlock or mode switch
   * so tunnels that armed while a secret was undecryptable (locked master key)
   * re-read the now-decryptable definition and can (re)connect on next access.
   * Best-effort per tunnel: one failure never aborts the sweep.
   */
  async reconcileAll() {
    const defs = this.#getStores().tunnelStore().list();
    for (const def of defs) {
      try {
        await this.reconcile(def.id);
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
      return await probeChain({
        hops: [...(Array.isArray(d.jumps) ? d.jumps : []), d.sshServer],
        destination: d.destination || {},
        tunnelId: d.id || "probe",
        hostVerifierFactory: (ctx) => this.#buildHostVerifier(ctx),
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
      getLingerMs: (d) => this.#effectiveLinger(d),
      onStateChange: (snapshot) => {
        this.#broadcast?.("porthippo:tunnel-state", snapshot);
        this.#onTunnelStateChange();
      },
    });
  }

  // ── Stats heartbeat (Feature 30) ──────────────────────────────────────────────
  // One throttled `porthippo:stats` snapshot of every tunnel, plus an immediate
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
    this.#broadcast?.("porthippo:stats", snapshots);
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
        this.#broadcast?.("porthippo:hostkey-changed", info),
    });
  }

  /** Emit an unknown-host-key prompt and return a promise resolved by the user. */
  #requestTrust(info) {
    const promptId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#prompts.set(promptId, { resolve });
      this.#broadcast?.("porthippo:hostkey-unknown", {
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
