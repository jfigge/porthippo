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
 * tunnel.js — the per-definition state machine that ties the listener, the shared
 * (lazily-established) SSH connection, the byte relays, and the idle-teardown timer
 * together.
 *
 * Lifecycle:
 *   disarmed → (arm) → listening → (first local connection) → connecting → connected
 *   → (idle > linger) → listening (SSH torn down, listener still bound)
 *   → (disarm) → disarmed
 *
 * The SSH connection is opened lazily on the first accepted local socket (unless the
 * definition sets `keepAlive`, which connects eagerly on arm and never idle-tears
 * down). A ref-count of live relays drives idle teardown: when it hits zero a linger
 * timer starts; if it fires, the SSH connection is disposed but the listener stays
 * bound so a later access re-opens it.
 *
 * Reconcile: while armed, a connection-affecting edit is applied immediately when the
 * tunnel is idle, or stashed as a **pending** change while clients are connected and
 * auto-applied once the last one disconnects. `forceApply()` applies a pending change
 * at once, dropping live connections. Cosmetic edits (name/order/lingerMs/
 * autoReconnect) update in place with no teardown.
 *
 * On an unexpected SSH drop the branch is `def.autoReconnect` (default false): false →
 * fail the connections and return to `listening` (re-establish on next access); true
 * (or `keepAlive`) → bounded-backoff reconnect, moving to `error` only on exhaustion.
 *
 * Forwarding type (Feature 110): a `local` tunnel binds a local port and forwards it
 * to a destination on first access (the flow described above). A `dynamic` tunnel
 * binds the local port as a SOCKS5 proxy and is otherwise identical (lazy connect,
 * idle linger). A `remote` tunnel binds NO local listener — it connects eagerly on
 * arm, asks the SSH server to bind a port (`forwardIn`), and relays each inbound
 * remote connection back to a local target; it holds the connection open like
 * `keepAlive` (there is no local access to lazily re-trigger it).
 */
"use strict";

const { Listener } = require("./listener");
const { connectChain, forwardIn } = require("./ssh-chain");
const { startRelay, startReverseRelay, startSocksRelay } = require("./relay");
const { Stats } = require("./stats");

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const MAX_RECONNECT_ATTEMPTS = 6;

const DEFAULT_BIND_HOST = "127.0.0.1";

/**
 * Does the change from `a` to `b` require re-binding / re-connecting? Cosmetic
 * fields (name, order, lingerMs, autoReconnect) are read live from the current
 * definition and never need a teardown.
 */
function connectionAffectingChange(a, b) {
  if ((a.type || "local") !== (b.type || "local")) return true;
  if (a.localPort !== b.localPort) return true;
  if ((a.bindHost || DEFAULT_BIND_HOST) !== (b.bindHost || DEFAULT_BIND_HOST))
    return true;
  if (Boolean(a.keepAlive) !== Boolean(b.keepAlive)) return true;
  if (Boolean(a.enabled) !== Boolean(b.enabled)) return true;
  if (JSON.stringify(a.destination) !== JSON.stringify(b.destination))
    return true;
  if (JSON.stringify(a.remoteBind) !== JSON.stringify(b.remoteBind))
    return true;
  if (JSON.stringify(a.sshServer) !== JSON.stringify(b.sshServer)) return true;
  if (JSON.stringify(a.jumps || []) !== JSON.stringify(b.jumps || []))
    return true;
  return false;
}

class Tunnel {
  #def;
  #deps;
  #stats;

  #state = "disarmed";
  #paused = false; // runtime pause toggle (Feature 30); orthogonal to #state
  #error = null;

  // Armed = between a successful arm() and teardown, INDEPENDENT of #listener: a
  // `remote` tunnel is armed with no local listener at all, so reconnect / error
  // decisions key off this rather than the listener's presence.
  #armed = false;
  #listener = null;
  #sshConnection = null; // { client, dispose } once connected
  #connectPromise = null; // in-flight connectChain (dedupes concurrent first hits)
  #connectGeneration = 0; // bumped by #teardown; a connect that resolves against a
  // stale generation was disarmed/reapplied mid-handshake and must not resurrect.

  #connections = new Set(); // live/pending connections: { socket, relay }
  #lingerTimer = null;
  #reconnectTimer = null;
  #reconnectAttempts = 0;

  // Feature 130 — reconnect visibility (surfaced, never algorithm-changing):
  #reconnecting = false; // in a backoff reconnect loop (drives `recovered` detection)
  #nextRetryAt = null; // epoch ms of the scheduled reconnect (Monitoring countdown)
  #transition = null; // one-shot lifecycle event carried on the NEXT emit only

  #pendingDef = null; // a connection-affecting edit awaiting an idle moment
  #disposed = false;

  /**
   * @param {object} def   the decrypted tunnel definition
   * @param {object} deps
   * @param {(ctx: object) => Function} deps.hostVerifierFactory  per-hop verifier
   * @param {(snapshot: object) => void} [deps.onStateChange]  state/pending changed
   * @param {(def: object) => number} deps.getLingerMs  effective linger for a def
   * @param {() => number} [deps.now]  injected clock for stats (ms epoch; tests)
   * @param {typeof import('fs').readFileSync} [deps.readFileSync]  key reads (tests)
   * @param {number} [deps.baseBackoffMs]  reconnect backoff base (tests shrink it)
   * @param {number} [deps.maxBackoffMs]  reconnect backoff ceiling (tests)
   * @param {number} [deps.maxReconnectAttempts]  attempts before give-up (tests)
   * @param {(def: object) => {baseMs:number,maxMs:number,maxAttempts:number}} [deps.getRetryPolicy]
   *        effective reconnect policy for a def (settings + per-tunnel override, F130)
   * @param {() => number} [deps.getSshKeepaliveMs]  ssh2 keepalive interval in ms
   *        (0 = off) threaded into every hop (F130)
   */
  constructor(def, deps) {
    this.#def = def;
    this.#deps = deps;
    this.#stats = new Stats({ now: deps.now });
  }

  get id() {
    return this.#def.id;
  }

  // ── Forwarding type (Feature 110) ─────────────────────────────────────────────

  #type() {
    return this.#def.type || "local";
  }

  #isRemote() {
    return this.#type() === "remote";
  }

  #isDynamic() {
    return this.#type() === "dynamic";
  }

  /**
   * True when the tunnel holds its SSH connection open independently of local
   * access: `keepAlive` (by request) or `remote` (structurally — the remote listen
   * only exists while connected, and nothing local can lazily re-trigger it). Such
   * tunnels connect eagerly on arm, never idle-tear-down, and never give up
   * reconnecting while armed.
   */
  #holdsOpen() {
    return Boolean(this.#def.keepAlive) || this.#isRemote();
  }

  /**
   * The reported lifecycle state. `paused` is a runtime overlay: while paused the
   * underlying machine (#state) keeps advancing (e.g. a lazy connect completing),
   * but the tunnel reports `paused` until resumed.
   */
  get state() {
    return this.#paused ? "paused" : this.#state;
  }

  /** A serializable snapshot for IPC status + `porthippo:tunnel-state` broadcasts. */
  status() {
    const snap = {
      id: this.#def.id,
      state: this.state,
      error: this.#error || undefined,
      pendingChanges: Boolean(this.#pendingDef),
      connections: this.#connections.size,
    };
    // Feature 130: the one-shot lifecycle transition (dropped / reconnecting /
    // recovered / gave-up) rides the broadcast that announces it, and the live
    // reconnect progress (attempt + countdown) rides every emit while retrying.
    if (this.#transition) snap.transition = this.#transition;
    this.#addReconnectFields(snap);
    return snap;
  }

  /** Fold the live reconnect progress (attempt + `nextRetryAt`) into a snapshot. */
  #addReconnectFields(snap) {
    if (!this.#reconnecting) return;
    snap.attempt = this.#reconnectAttempts + 1; // the attempt currently in flight
    if (this.#nextRetryAt) snap.nextRetryAt = this.#nextRetryAt;
  }

  /**
   * The Feature 30 metrics snapshot for the `porthippo:stats` stream: the tunnel's
   * reported state + error merged with its `Stats` (rates, totals, timestamps).
   * Plain serializable data — no live handles cross IPC.
   */
  statsSnapshot() {
    const snap = {
      id: this.#def.id,
      state: this.state,
      error: this.#error || null,
      ...this.#stats.snapshot(),
    };
    // Carry the reconnect progress on the heartbeat too so Monitoring's countdown
    // keeps ticking between the discrete state broadcasts (Feature 130).
    this.#addReconnectFields(snap);
    return snap;
  }

  /** The bounded error/warning event log (oldest first) the "Errors" card opens. */
  events() {
    return this.#stats.events();
  }

  // ── Arm / disarm ──────────────────────────────────────────────────────────────

  /**
   * Arm the tunnel. For `local`/`dynamic` this binds the local listener (SOCKS for
   * dynamic) and, if `keepAlive`, connects eagerly. A `remote` tunnel binds no local
   * listener — it arms and connects eagerly so the SSH server can bind the forward.
   */
  async arm() {
    if (this.#disposed) return this.status();

    if (this.#listener) {
      await this.#listener.stop();
      this.#listener = null;
    }
    this.#error = null;
    this.#paused = false; // a (re)arm always starts accepting

    if (this.#isRemote()) {
      // No local listener: the far end binds the port. Arm and connect eagerly so
      // the reverse forward is established (and re-established on any drop).
      this.#armed = true;
      this.#stats.onArmed();
      this.#setState("listening");
      this.#ensureConnected().catch((err) => this.#failConnect(err));
      return this.status();
    }

    const listener = new Listener({
      bindHost: this.#def.bindHost || DEFAULT_BIND_HOST,
      port: this.#def.localPort,
      onConnection: (socket) => this.#handleConnection(socket),
      onError: (err) => this.#handleListenerError(err),
    });

    try {
      await listener.start();
    } catch (err) {
      this.#recordError(err.message);
      this.#setState("error");
      return this.status();
    }

    // A dispose()/disarm() that raced this bind ran #teardown() while #listener was
    // still unassigned, so it couldn't stop the socket now finishing its bind.
    // Re-check and stop it here rather than assign a live listener onto a torn-down
    // tunnel — otherwise the port stays bound on a dead object and the next re-arm
    // hits EADDRINUSE.
    if (this.#disposed) {
      await listener.stop();
      return this.status();
    }

    this.#listener = listener;
    this.#armed = true;
    this.#stats.onArmed(); // fresh measurement session (stamps armedAt, zeroes totals)
    this.#setState("listening");

    if (this.#holdsOpen()) {
      this.#ensureConnected().catch((err) => this.#failConnect(err));
    }
    return this.status();
  }

  /** Tear everything down (listener, SSH, relays, timers) → disarmed. */
  async disarm() {
    // Drop any pending edit BEFORE teardown. #teardown() closes the live relays,
    // and a relay's onClose fires synchronously → #onIdleCheck() → #maybeApplyPending().
    // If #pendingDef were still set, that would reentrantly #reapply() (re-arm) the
    // very tunnel we're stopping — leaving a fresh listener bound instead of disarmed.
    // (dispose() is immune because it sets #disposed first, so the reentrant arm() no-ops.)
    this.#pendingDef = null;
    await this.#teardown();
    this.#paused = false;
    this.#stats.onDisarmed();
    this.#setState("disarmed");
    return this.status();
  }

  /** Permanent teardown (engine dropping this tunnel or app quit). */
  async dispose() {
    this.#disposed = true;
    await this.#teardown();
    this.#pendingDef = null;
    this.#paused = false;
    this.#stats.onDisarmed();
    this.#state = "disarmed";
  }

  // ── Reconcile (edits) ─────────────────────────────────────────────────────────

  /**
   * React to an edited definition. Cosmetic edits apply in place; connection-
   * affecting edits apply immediately when idle, else stash as pending.
   */
  applyDefinition(newDef) {
    if (!connectionAffectingChange(this.#def, newDef)) {
      this.#def = newDef; // name/order/lingerMs/autoReconnect — live, no teardown
      this.#emitState();
      return;
    }
    if (this.#state === "disarmed") {
      this.#def = newDef; // takes effect on next arm
      return;
    }
    if (this.#connections.size === 0) {
      this.#reapply(newDef); // idle → apply now
    } else {
      this.#pendingDef = newDef; // active → wait for idle (or forceApply)
      this.#emitState();
    }
  }

  /**
   * Apply a pending change immediately, forcing live connections to disconnect.
   * Returns the re-apply promise so callers can await the settled state (and so a
   * failure surfaces to them instead of becoming an unhandled rejection).
   */
  forceApply() {
    if (!this.#pendingDef) return Promise.resolve();
    const next = this.#pendingDef;
    this.#pendingDef = null;
    return this.#reapply(next);
  }

  /** Disarm + re-arm with `newDef` (or leave disarmed if the edit disabled it). */
  async #reapply(newDef) {
    await this.#teardown();
    this.#def = newDef;
    if (newDef.enabled) {
      await this.arm();
    } else {
      this.#setState("disarmed");
    }
  }

  #maybeApplyPending() {
    if (!this.#pendingDef || this.#connections.size > 0) return;
    const next = this.#pendingDef;
    this.#pendingDef = null;
    this.#reapply(next);
  }

  // ── Pause / resume (Feature 30) ───────────────────────────────────────────────

  /**
   * Suspend traffic without tearing anything down: stop the listener accepting
   * new connections and freeze byte flow on every live relay, while keeping the
   * SSH connection and all sockets alive. Rates read zero and totals freeze;
   * `openedAt` / `armedAt` keep ticking. No-op unless armed.
   */
  pause() {
    if (this.#disposed || this.#paused) return this.status();
    if (this.#state === "disarmed" || this.#state === "error")
      return this.status();
    this.#paused = true;
    this.#cancelLinger(); // paused must never idle-tear-down the SSH connection
    for (const conn of this.#connections) conn.relay?.pause();
    this.#emitState();
    return this.status();
  }

  /** Reverse pause(): re-accept new connections and un-freeze live relays. */
  resume() {
    if (this.#disposed || !this.#paused) return this.status();
    this.#paused = false;
    for (const conn of this.#connections) conn.relay?.resume();
    this.#maybeStartLinger(); // resume the idle countdown if we're now idle
    this.#emitState();
    return this.status();
  }

  // ── Local connection handling ─────────────────────────────────────────────────

  #isAccepting() {
    return Boolean(this.#listener) && !this.#disposed && !this.#paused;
  }

  #handleConnection(socket) {
    if (!this.#isAccepting()) {
      socket.destroy();
      return;
    }
    this.#cancelLinger();

    const conn = { socket, relay: null };
    this.#connections.add(conn);

    // If the socket dies before its relay exists, drop it from the ref-count.
    socket.once("close", () => {
      if (conn.relay) return; // the relay now owns the lifecycle
      if (this.#connections.delete(conn)) this.#onIdleCheck();
    });
    // A socket `error` raised before the relay exists — a client reset mid-
    // handshake, or a reset while an unknown host key sits at a (possibly minutes-
    // long) TOFU prompt — would otherwise be an unhandled 'error' event that
    // crashes the entire main process, killing every other tunnel. Absorb it here;
    // the paired `close` above does the ref-count cleanup, and once the relay
    // exists it wires its own `error` handling (`relay.js`).
    socket.once("error", () => {
      if (conn.relay) return; // the relay now owns the socket's error handling
      socket.destroy();
    });

    this.#ensureConnected()
      .then((sshConn) => {
        if (this.#disposed || !this.#connections.has(conn)) {
          socket.destroy();
          return;
        }
        const relayOpts = {
          client: sshConn.client,
          socket,
          stats: this.#stats,
          onOpen: () => {
            // A forward succeeded → clear any stale forward error so a transient
            // destination hiccup doesn't stick once traffic is flowing again.
            if (this.#error) {
              this.#error = null;
              this.#emitState();
            }
          },
          onClose: () => {
            if (this.#connections.delete(conn)) this.#onIdleCheck();
          },
          onError: (err) => {
            // The forwarded channel failed to open — destination refused/unreachable,
            // or an ACL denial on the SSH server. The relay already tore the local
            // socket down and will fire onClose; record the reason so a misconfigured
            // destination is visible instead of the tunnel sitting silently
            // "connected" while every forward fails.
            this.#recordError(
              String((err && err.message) || err || "forward failed"),
            );
            this.#emitState();
          },
        };
        // dynamic → the client picks the target via a SOCKS handshake; local →
        // the fixed destination. Both feed the same stats + connection ref-count.
        conn.relay = this.#isDynamic()
          ? startSocksRelay(relayOpts)
          : startRelay({ ...relayOpts, destination: this.#def.destination });
        // A pause that landed while this connection was still connecting applies
        // to its relay the moment it exists.
        if (this.#paused) conn.relay.pause();
        this.#emitState(); // connection count changed
      })
      .catch((err) => {
        this.#connections.delete(conn);
        socket.destroy();
        this.#failConnect(err);
      });
  }

  // ── Reverse (remote-forward) connection handling (Feature 110) ────────────────

  /**
   * Establish the reverse forward once the SSH session is up: attach the inbound
   * handler, then ask the server to bind `remoteBind`. A bind failure surfaces as a
   * connect failure so the reconnect/error policy applies.
   */
  async #setupRemoteForward(sshConn) {
    // Attach the inbound handler BEFORE binding so a connection that arrives the
    // instant the forward is up isn't missed.
    sshConn.client.on("tcp connection", (info, accept, reject) =>
      this.#handleReverseConnection(sshConn, accept, reject),
    );
    const bind = this.#def.remoteBind || {};
    await forwardIn(sshConn.client, bind.host || DEFAULT_BIND_HOST, bind.port);
  }

  /** An inbound connection arrived on the remote-bound port: relay it to the local target. */
  #handleReverseConnection(sshConn, accept, reject) {
    // Reject if this session is stale, we're paused, or torn down.
    if (this.#sshConnection !== sshConn || this.#paused || this.#disposed) {
      try {
        reject();
      } catch {
        // channel already gone
      }
      return;
    }
    let stream;
    try {
      stream = accept();
    } catch {
      return; // the channel could not be accepted
    }
    const conn = { socket: null, relay: null };
    this.#connections.add(conn);
    conn.relay = startReverseRelay({
      stream,
      destination: this.#def.destination,
      stats: this.#stats,
      onOpen: () => {
        if (this.#error) {
          this.#error = null;
          this.#emitState();
        }
      },
      onClose: () => {
        if (this.#connections.delete(conn)) this.#onIdleCheck();
      },
      onError: (err) => {
        // The local target refused/was unreachable. Record it so a misconfigured
        // local target is visible rather than silently dropping every callback.
        this.#recordError(
          String((err && err.message) || err || "local target failed"),
        );
        this.#emitState();
      },
    });
    this.#emitState(); // connection count changed
  }

  #onIdleCheck() {
    if (this.#connections.size > 0) return;
    this.#maybeStartLinger();
    this.#maybeApplyPending();
    this.#emitState();
  }

  /**
   * Record an error: set the reported `error` string AND append it to the stats
   * event log (which the "Errors" card opens) + bump the count. The single seam
   * every error path funnels through, so the log and the count can't diverge.
   */
  #recordError(message) {
    this.#error = message;
    this.#stats.onError(message);
  }

  #handleListenerError(err) {
    this.#recordError(err.message);
    this.#setState("error");
  }

  // ── SSH connection lifecycle ──────────────────────────────────────────────────

  #ensureConnected() {
    if (this.#sshConnection) return Promise.resolve(this.#sshConnection);
    if (this.#connectPromise) return this.#connectPromise;

    this.#setState("connecting");
    const hops = [...(this.#def.jumps || []), this.#def.sshServer];
    const generation = this.#connectGeneration;

    this.#connectPromise = connectChain({
      hops,
      tunnelId: this.#def.id,
      hostVerifierFactory: this.#deps.hostVerifierFactory,
      readFileSync: this.#deps.readFileSync,
      keepaliveInterval: this.#deps.getSshKeepaliveMs?.() ?? 0,
    })
      .then((sshConn) => {
        this.#connectPromise = null;
        // A disarm / reapply / dispose during the handshake bumps the generation
        // (dispose also sets #disposed). Either way this SSH session is orphaned:
        // dispose it and resolve WITHOUT touching tunnel state, rather than
        // resurrecting a connection teardown already accounted for. Callers guard
        // the resolved value (#handleConnection checks #connections; the eager /
        // reconnect callers only wire .catch), so a no-op resolve is safe.
        if (this.#disposed || generation !== this.#connectGeneration) {
          try {
            sshConn.dispose();
          } catch {
            // disposing an already-closing connection is fine
          }
          return sshConn;
        }
        // A reconnect loop that finally connected is a *recovery* — flag it so the
        // state broadcast carries the `recovered` transition (drives the notice).
        const wasReconnecting = this.#reconnecting;
        this.#sshConnection = sshConn;
        this.#reconnectAttempts = 0;
        this.#reconnecting = false;
        this.#nextRetryAt = null;
        this.#error = null;
        this.#stats.onConnected(); // stamp openedAt for this SSH session
        this.#wireDrop(sshConn);
        this.#setState("connected", wasReconnecting ? "recovered" : undefined);
        if (this.#isRemote()) {
          // Bind the remote port + wire inbound; a bind failure drops the session
          // and re-enters the reconnect policy.
          this.#setupRemoteForward(sshConn).catch((err) =>
            this.#handleRemoteForwardError(sshConn, err),
          );
        }
        this.#maybeStartLinger(); // eager (keepAlive/reconnect) connect with no clients
        return sshConn;
      })
      .catch((err) => {
        this.#connectPromise = null;
        throw err;
      });
    return this.#connectPromise;
  }

  /** Detect an unexpected drop of a *current* SSH connection. */
  #wireDrop(sshConn) {
    const onDrop = (err) => {
      // Identity check: an intentional dispose nulls #sshConnection first, so a
      // teardown-triggered close/error is ignored here (not treated as a drop).
      if (this.#sshConnection !== sshConn) return;
      this.#handleDrop(err);
    };
    sshConn.client.on("close", () => onDrop());
    sshConn.client.on("error", (err) => onDrop(err));
  }

  #handleDrop(err) {
    this.#sshConnection = null;
    this.#stats.onDisconnected(); // this SSH session is over; openedAt clears
    this.#recordError(
      err ? String(err.message || err) : "SSH connection dropped",
    );
    this.#failAllConnections();
    this.#cancelLinger();

    // Announce the unexpected drop (Feature 130) before deciding the next move,
    // so the notification / health layers see it whether or not we reconnect.
    this.#emitState("dropped");

    if (this.#shouldStayHot()) {
      this.#attemptReconnect();
    } else {
      this.#setState("listening"); // re-establish on next access
      this.#maybeApplyPending();
    }
  }

  /**
   * The reverse forward couldn't be established (the SSH session is up but the
   * server refused / failed the port bind). Drop this session and re-enter the
   * reconnect policy — a `remote` tunnel `#holdsOpen()`, so it keeps retrying.
   */
  #handleRemoteForwardError(sshConn, err) {
    if (this.#sshConnection !== sshConn) return; // a newer session/teardown won
    this.#recordError(
      String((err && err.message) || err || "remote bind failed"),
    );
    this.#disposeSsh(); // ends the client (nulls #sshConnection, stats.onDisconnected)
    this.#failAllConnections();
    this.#cancelLinger();
    if (this.#shouldStayHot()) {
      this.#attemptReconnect();
    } else {
      this.#setState(this.#armed ? "error" : "disarmed");
    }
  }

  #shouldStayHot() {
    return this.#holdsOpen() || Boolean(this.#def.autoReconnect);
  }

  /**
   * The effective reconnect policy: the test-injected shrink values win (harness),
   * then the engine-supplied settings + per-tunnel override (Feature 130), then the
   * module defaults. Read live on each schedule so a settings edit takes effect on
   * the next attempt without re-arming.
   */
  #retryPolicy() {
    const resolved = this.#deps.getRetryPolicy?.(this.#def) || {};
    return {
      baseMs: this.#deps.baseBackoffMs ?? resolved.baseMs ?? BASE_BACKOFF_MS,
      maxMs: this.#deps.maxBackoffMs ?? resolved.maxMs ?? MAX_BACKOFF_MS,
      maxAttempts:
        this.#deps.maxReconnectAttempts ??
        resolved.maxAttempts ??
        MAX_RECONNECT_ATTEMPTS,
    };
  }

  #nowMs() {
    return (this.#deps.now || Date.now)();
  }

  #attemptReconnect() {
    if (this.#disposed || this.#reconnectTimer) return;
    this.#reconnecting = true;
    const { baseMs, maxMs } = this.#retryPolicy();
    const delay = Math.min(maxMs, baseMs * 2 ** this.#reconnectAttempts);
    this.#nextRetryAt = this.#nowMs() + delay;
    // Surface the scheduled retry (attempt + countdown ride the snapshot).
    this.#setState("connecting", "reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      // Armed (not listener) is the gate: a `remote` tunnel has no listener but is
      // still armed and must keep reconnecting.
      if (this.#disposed || !this.#armed) return;
      this.#ensureConnected().catch(() => this.#onReconnectFailed());
    }, delay);
  }

  /** A backoff reconnect attempt failed: retry, hold, or (finally) give up. */
  #onReconnectFailed() {
    const { maxAttempts } = this.#retryPolicy();
    this.#reconnectAttempts += 1;
    if (this.#reconnectAttempts < maxAttempts) {
      this.#attemptReconnect();
      return;
    }
    if (this.#holdsOpen()) {
      // A held-open tunnel (keepAlive or remote) has no local access to trigger a
      // later retry, so it must never give up: pin the delay at the max backoff and
      // keep trying until it reconnects or is disarmed. (autoReconnect, below, can
      // stop and retry on next access.)
      this.#reconnectAttempts = maxAttempts;
      this.#attemptReconnect();
      return;
    }
    // Reconnection is exhausted: announce it (Feature 130) and latch to error;
    // the next local access re-establishes the chain.
    this.#reconnectAttempts = 0;
    this.#reconnecting = false;
    this.#nextRetryAt = null;
    this.#setState("error", "gave-up");
  }

  /** A connect attempt failed (lazy connect, eager keepAlive/remote, or reconnect). */
  #failConnect(err) {
    this.#recordError(
      String((err && err.message) || err || "connection failed"),
    );
    if (this.#shouldStayHot()) {
      this.#attemptReconnect();
    } else {
      // Keep the listener bound; the next local access retries the chain.
      this.#setState(this.#armed ? "error" : "disarmed");
    }
  }

  // ── Idle teardown (linger) ────────────────────────────────────────────────────

  #maybeStartLinger() {
    if (this.#paused) return; // paused holds the SSH connection open regardless
    if (this.#holdsOpen()) return; // keepAlive / remote never idle-tear-down
    if (this.#connections.size > 0) return;
    if (!this.#sshConnection || this.#lingerTimer) return;

    const ms = this.#deps.getLingerMs(this.#def);
    this.#lingerTimer = setTimeout(() => {
      this.#lingerTimer = null;
      if (this.#connections.size === 0 && this.#sshConnection) {
        this.#disposeSsh();
        this.#setState("listening");
        this.#maybeApplyPending();
      }
    }, ms);
  }

  #cancelLinger() {
    if (this.#lingerTimer) {
      clearTimeout(this.#lingerTimer);
      this.#lingerTimer = null;
    }
  }

  #cancelReconnect() {
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#reconnectAttempts = 0;
    this.#reconnecting = false;
    this.#nextRetryAt = null;
  }

  // ── Teardown helpers ──────────────────────────────────────────────────────────

  #failAllConnections() {
    for (const conn of [...this.#connections]) {
      if (conn.relay) {
        try {
          conn.relay.close();
        } catch {
          // ignore
        }
      } else {
        try {
          conn.socket.destroy();
        } catch {
          // ignore
        }
      }
    }
    this.#connections.clear();
  }

  #disposeSsh() {
    const conn = this.#sshConnection;
    this.#sshConnection = null; // null first so #wireDrop ignores the close it triggers
    this.#connectPromise = null;
    if (conn) {
      this.#stats.onDisconnected(); // openedAt clears with the session
      try {
        conn.dispose();
      } catch {
        // ending an already-closed connection is fine
      }
    }
  }

  async #teardown() {
    // Invalidate any in-flight connect: its .then resolves into a no-op instead
    // of resurrecting an SSH session this teardown is destroying.
    this.#connectGeneration += 1;
    this.#armed = false;
    this.#cancelReconnect();
    this.#failAllConnections();
    this.#disposeSsh();
    // Cancel the linger LAST: failing the connections above runs the idle check,
    // which (while the SSH connection is briefly still up) can start a linger
    // timer. Clearing it here guarantees teardown never leaves a pending timer
    // holding the event loop open for the full lingerMs.
    this.#cancelLinger();
    if (this.#listener) {
      await this.#listener.stop();
      this.#listener = null;
    }
  }

  // ── State emission ────────────────────────────────────────────────────────────

  #setState(state, transition) {
    this.#state = state;
    this.#emitState(transition);
  }

  /**
   * Emit the current status. `transition` (Feature 130) is a one-shot lifecycle
   * event (dropped / reconnecting / recovered / gave-up) carried ONLY on this
   * broadcast, so a later plain status() poll never re-reports a stale transition.
   */
  #emitState(transition) {
    this.#transition = transition || null;
    this.#deps.onStateChange?.(this.status());
    this.#transition = null;
  }
}

module.exports = { Tunnel, connectionAffectingChange };
