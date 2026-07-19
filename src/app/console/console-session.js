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
 * console-session.js — one live interactive-shell session (Feature 200).
 *
 * A session owns the SSH chain to a console's target server (built with the SAME
 * `connectChain()` a tunnel uses — jump-host chaining, per-hop auth, host-key TOFU
 * through the shared mediator, and the injected `keyReader`) and, on top of the
 * final hop, an ssh2 `shell()` pty channel. Bytes the shell emits are relayed to
 * the console window (`console:data`); the window's keystrokes come back through
 * `write()` and its resizes through `setWindow()`. There is no forwarding, no
 * listener, no relay counters — a console is not a tunnel; the chain terminates at
 * the target server and a shell is opened there.
 *
 * Lifecycle is one-shot and fail-closed: `connecting → connected → (closed|error)`.
 * A dropped connection or a shell exit ends the session and tells the window; the
 * user reopens (shell state is in-memory and must never be silently re-established).
 */
"use strict";

const { connectChain } = require("../tunnel/ssh-chain");

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TERM = "xterm-256color";

class ConsoleSession {
  #def;
  #sessionId;
  #hostKeys;
  #keyReader;
  #keepaliveMs;
  #send;
  #onState;
  #onEnd;

  #chain = null; // { client, dispose } from connectChain
  #stream = null; // the ssh2 shell channel
  #state = "idle";
  #terminal = false; // set once the session reaches a closed/error end state

  /**
   * @param {object} opts
   * @param {object} opts.def          resolved console `{ id, name, sshServer, jumps }`
   * @param {string} opts.sessionId
   * @param {import('../tunnel/host-key-mediator').HostKeyMediator} opts.hostKeys
   * @param {typeof import('fs').readFileSync} opts.keyReader
   * @param {number} opts.keepaliveMs  ssh2 keepalive interval (0 = off)
   * @param {(channel: string, payload: object) => void} opts.send  push to the window
   * @param {(snapshot: object) => void} opts.onState  state-transition callback
   * @param {() => void} opts.onEnd     called exactly once when the session terminates
   */
  constructor({
    def,
    sessionId,
    hostKeys,
    keyReader,
    keepaliveMs,
    send,
    onState,
    onEnd,
  }) {
    this.#def = def || {};
    this.#sessionId = sessionId;
    this.#hostKeys = hostKeys;
    this.#keyReader = keyReader;
    this.#keepaliveMs = keepaliveMs || 0;
    this.#send = send || (() => {});
    this.#onState = onState || (() => {});
    this.#onEnd = onEnd || (() => {});
  }

  get sessionId() {
    return this.#sessionId;
  }

  get consoleId() {
    return this.#def.id;
  }

  get state() {
    return this.#state;
  }

  /**
   * Connect the chain and open the shell, sized to the window's real grid. Called
   * once, when the window signals it is ready. Never throws for an expected failure
   * — a connect/shell error ends the session and notifies the window instead.
   */
  async start({ cols, rows } = {}) {
    if (this.#terminal || this.#chain) return;
    const w = { cols: cols || DEFAULT_COLS, rows: rows || DEFAULT_ROWS };
    this.#setState("connecting");

    let chain;
    try {
      chain = await connectChain({
        hops: [
          ...(Array.isArray(this.#def.jumps) ? this.#def.jumps : []),
          this.#def.sshServer,
        ],
        tunnelId: this.#def.id || this.#sessionId,
        hostVerifierFactory: (ctx) => this.#hostKeys.buildVerifier(ctx),
        readFileSync: this.#keyReader,
        keepaliveInterval: this.#keepaliveMs,
      });
    } catch (err) {
      this.#end("error", (err && err.message) || "connection failed");
      return;
    }
    // Disposed while connecting (window closed) — drop the freshly-built chain.
    if (this.#terminal) {
      try {
        chain.dispose();
      } catch {
        /* already torn down */
      }
      return;
    }
    this.#chain = chain;

    // A drop at the SSH layer (dead peer, server close) ends the session.
    chain.client.on("close", () => this.#end("closed", "connection closed"));
    chain.client.on("error", (err) =>
      this.#end("error", (err && err.message) || "connection error"),
    );

    chain.client.shell(
      { term: TERM, cols: w.cols, rows: w.rows, width: 0, height: 0 },
      (err, stream) => {
        if (err) {
          this.#end("error", (err && err.message) || "shell failed");
          return;
        }
        if (this.#terminal) {
          try {
            stream.close();
          } catch {
            /* already gone */
          }
          return;
        }
        this.#stream = stream;
        this.#setState("connected");

        stream.on("data", (chunk) => this.#emit(chunk));
        // With a pty, stderr is folded into the main channel — relay it too in the
        // rare case a server splits it, so nothing is silently dropped.
        stream.stderr?.on("data", (chunk) => this.#emit(chunk));
        stream.on("close", () => this.#end("closed", "session closed"));
        stream.on("error", () => {
          /* the close handler drives teardown; swallow the error event */
        });
      },
    );
  }

  /** Write the window's keystrokes to the shell (best-effort). */
  write(data) {
    if (this.#terminal || !this.#stream) return;
    try {
      this.#stream.write(data);
    } catch {
      /* the stream may be mid-teardown */
    }
  }

  /** Apply a window resize to the remote pty (rows, cols order for ssh2). */
  setWindow(cols, rows) {
    if (this.#terminal || !this.#stream) return;
    try {
      this.#stream.setWindow(rows || DEFAULT_ROWS, cols || DEFAULT_COLS, 0, 0);
    } catch {
      /* resize is best-effort */
    }
  }

  /** Tear the session down (the window closed). Silent — no window notification. */
  dispose() {
    this.#end("closed", "window closed", { notifyWindow: false });
  }

  /** Relay one output chunk to the window as raw bytes (byte-safe for UTF-8). */
  #emit(chunk) {
    if (this.#terminal) return;
    this.#send("console:data", { data: new Uint8Array(chunk) });
  }

  #setState(state, detail) {
    this.#state = state;
    this.#onState({
      id: this.#def.id,
      sessionId: this.#sessionId,
      state,
      ...(detail ? { detail } : {}),
    });
  }

  /**
   * Reach a terminal state exactly once: broadcast the final state, optionally tell
   * the window why it closed, dispose the SSH resources, and fire onEnd so the
   * manager forgets the session.
   */
  #end(state, reason, { notifyWindow = true } = {}) {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#setState(state, reason);
    if (notifyWindow) {
      this.#send("console:closed", { reason, error: state === "error" });
    }
    try {
      this.#stream?.close();
    } catch {
      /* already closed */
    }
    this.#stream = null;
    try {
      this.#chain?.dispose();
    } catch {
      /* already disposed */
    }
    this.#chain = null;
    this.#onEnd();
  }
}

module.exports = { ConsoleSession };
