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
 * console-manager.js — the single `ConsoleManager` that owns every live console
 * session (Feature 200). The console-side sibling of the tunnel engine.
 *
 * It holds a `Map<sessionId, ConsoleSession>`, reads resolved+decrypted console
 * definitions from the store, and reuses the SHARED host-key mediator + injected
 * `keyReader` so a console connects exactly like a tunnel. It never imports
 * Electron: opening the terminal window and pushing bytes to it are injected
 * (`openWindow` / `sendToWindow`), and live session state reaches the renderer
 * through the injected `broadcast` (`jumphippo:console-state`, ids only — never a
 * secret).
 *
 * Connect is deferred: `open()` mints the session + window immediately, then the
 * window signals `ready(cols, rows)` once its terminal is sized, and only then
 * does the session dial out — so the remote pty is created at the right size.
 */
"use strict";

const crypto = require("crypto");

const { ConsoleSession } = require("./console-session");

class ConsoleManager {
  #getStores;
  #broadcast;
  #hostKeys;
  #keyReader;
  #getSshKeepaliveMs;
  #openWindow;
  #sendToWindow;

  #sessions = new Map(); // sessionId → ConsoleSession

  /**
   * @param {object} deps
   * @param {() => import('../store/stores').Stores} deps.getStores
   * @param {(channel: string, payload: object) => void} [deps.broadcast]
   * @param {import('../tunnel/host-key-mediator').HostKeyMediator} deps.hostKeys
   * @param {typeof import('fs').readFileSync} [deps.keyReader]
   * @param {() => number} [deps.getSshKeepaliveMs]  ssh2 keepalive interval (0 = off)
   * @param {(sessionId: string, meta: {title: string}) => void} deps.openWindow
   * @param {(sessionId: string, channel: string, payload: object) => void} deps.sendToWindow
   */
  constructor({
    getStores,
    broadcast,
    hostKeys,
    keyReader,
    getSshKeepaliveMs,
    openWindow,
    sendToWindow,
  }) {
    this.#getStores = getStores;
    this.#broadcast = broadcast;
    this.#hostKeys = hostKeys;
    this.#keyReader = keyReader;
    this.#getSshKeepaliveMs = getSshKeepaliveMs || (() => 0);
    this.#openWindow = openWindow || (() => {});
    this.#sendToWindow = sendToWindow || (() => {});
  }

  /**
   * Open a console by id: resolve it, create a session, and open its terminal
   * window. The SSH connect is deferred to `ready()`. Returns `{ sessionId, id }`.
   * Throws NOT_FOUND for an unknown / unresolvable console.
   */
  open(consoleId) {
    const def = this.#getStores().consoleStore().getDecrypted(consoleId);
    if (!def) {
      const err = new Error(`console not found: ${consoleId}`);
      err.code = "NOT_FOUND";
      throw err;
    }
    const view = this.#getStores().consoleStore().get(consoleId);
    const title = (view && view.name) || def.name || "Console";

    const sessionId = crypto.randomUUID();
    const session = new ConsoleSession({
      def,
      sessionId,
      hostKeys: this.#hostKeys,
      keyReader: this.#keyReader,
      keepaliveMs: this.#getSshKeepaliveMs(),
      send: (channel, payload) =>
        this.#sendToWindow(sessionId, channel, payload),
      onState: (snapshot) =>
        this.#broadcast?.("jumphippo:console-state", snapshot),
      onEnd: () => this.#sessions.delete(sessionId),
    });
    this.#sessions.set(sessionId, session);

    // Announce the pending session so the sidebar row lamp lights immediately.
    this.#broadcast?.("jumphippo:console-state", {
      id: consoleId,
      sessionId,
      state: "connecting",
    });

    this.#openWindow(sessionId, { title });
    return { sessionId, id: consoleId };
  }

  /** The window is ready + sized — dial out and open the shell. */
  ready(sessionId, { cols, rows } = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.start({ cols, rows }).catch((err) => {
      console.error(
        `[console] session ${sessionId} start failed:`,
        err && err.message,
      );
    });
  }

  /** Forward the window's keystrokes to the shell. */
  input(sessionId, data) {
    this.#sessions.get(sessionId)?.write(data);
  }

  /** Forward a window resize to the remote pty. */
  resize(sessionId, cols, rows) {
    this.#sessions.get(sessionId)?.setWindow(cols, rows);
  }

  /**
   * The window closed (or an explicit close intent) — tear the session down. A
   * no-op if the session already ended on its own (shell exit / drop).
   */
  close(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.dispose(); // onEnd is a no-op delete after the map entry is gone
    this.#broadcast?.("jumphippo:console-state", {
      id: session.consoleId,
      sessionId,
      state: "closed",
    });
  }

  /** Active-session snapshot (id + sessionId + state) for the sidebar row lamps. */
  sessions() {
    return [...this.#sessions.values()].map((s) => ({
      id: s.consoleId,
      sessionId: s.sessionId,
      state: s.state,
    }));
  }

  /** Dispose every session (app quit). */
  disposeAll() {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const s of sessions) {
      try {
        s.dispose();
      } catch {
        /* best-effort teardown */
      }
    }
  }
}

module.exports = { ConsoleManager };
