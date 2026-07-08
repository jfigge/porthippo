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
 * listener.js — the local TCP listener a tunnel binds on `bindHost:localPort`.
 *
 * The listener binds as soon as a tunnel is armed and stays bound for the tunnel's
 * whole armed lifetime; the SSH connection is opened lazily by the owning Tunnel on
 * the first accepted socket (that is what makes forwarding "on-demand"). Bind
 * failures — address already in use, a privileged port bound without privileges,
 * an unavailable local address — are translated into structured `{ code }` errors
 * and rejected from `start()` (or reported via `onError` after a successful bind)
 * so the engine can move the tunnel to `error` rather than crash the process.
 */
"use strict";

const net = require("net");

/** Unix ports below this need elevated privileges to bind. */
const PRIVILEGED_PORT_MAX = 1024;

class Listener {
  #server = null;
  #bindHost;
  #port;
  #onConnection;
  #onError;

  /**
   * @param {object} opts
   * @param {string} opts.bindHost      local address to bind (default 127.0.0.1)
   * @param {number} opts.port          local port to bind
   * @param {(socket: import('net').Socket) => void} opts.onConnection  accepted
   *        socket hook (the Tunnel lazily connects SSH + starts a relay)
   * @param {(err: Error) => void} [opts.onError]  post-bind runtime listener error
   */
  constructor({ bindHost, port, onConnection, onError }) {
    this.#bindHost = bindHost || "127.0.0.1";
    this.#port = port;
    this.#onConnection = onConnection;
    this.#onError = onError;
  }

  /**
   * Bind the listener. Resolves once it is listening; rejects with a structured
   * error (carrying the original `.code`) if the bind fails.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const server = net.createServer((socket) => this.#onConnection?.(socket));

      server.on("error", (err) => {
        const structured = this.#translateError(err);
        if (!settled) {
          // A failure before we are listening is a bind failure: reject only.
          settled = true;
          reject(structured);
          return;
        }
        // A failure after a successful bind is a runtime listener error.
        this.#onError?.(structured);
      });

      server.listen(this.#port, this.#bindHost, () => {
        settled = true;
        this.#server = server;
        resolve();
      });
    });
  }

  /**
   * Stop listening. Idempotent; resolves once the socket is closed. In-flight
   * relayed connections are owned by the Tunnel and are not touched here.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      const server = this.#server;
      if (!server) return resolve();
      this.#server = null;
      server.close(() => resolve());
    });
  }

  /** True while the listener is bound. */
  get listening() {
    return this.#server !== null;
  }

  /** The bound address (`{ address, family, port }`) or null when not bound. */
  address() {
    return this.#server ? this.#server.address() : null;
  }

  /** Translate a raw net error into a structured, user-facing tunnel error. */
  #translateError(err) {
    const code = err && err.code ? err.code : "LISTEN_FAILED";
    const where = `${this.#bindHost}:${this.#port}`;
    let message;
    if (code === "EADDRINUSE") {
      message = `local address ${where} is already in use`;
    } else if (code === "EACCES") {
      message =
        this.#port < PRIVILEGED_PORT_MAX
          ? `permission denied binding privileged port ${where} ` +
            `(ports below ${PRIVILEGED_PORT_MAX} need elevated privileges)`
          : `permission denied binding ${where}`;
    } else if (code === "EADDRNOTAVAIL") {
      message = `local address ${this.#bindHost} is not available on this host`;
    } else {
      message = (err && err.message) || `failed to bind ${where}`;
    }
    const out = new Error(message);
    out.code = code;
    return out;
  }
}

module.exports = { Listener };
