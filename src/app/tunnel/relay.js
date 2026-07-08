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
 * relay.js — bridge one accepted local socket to the destination over the SSH
 * connection, counting bytes in both directions.
 *
 * We open a `direct-tcpip` channel from the final (destination-reaching) SSH client
 * to `destination.host:port`, then pipe the local socket and that channel into each
 * other. Because we own both ends of the pipe we count every byte (into `counters`
 * and, when supplied, the tunnel's Feature 30 `stats`) and tear a single connection
 * down precisely. Either side closing or erroring ends the other, and `onClose`
 * fires exactly once so the owning Tunnel can decrement its live-connection
 * ref-count.
 *
 * Pause/resume (Feature 30) freezes byte flow without dropping the connection: the
 * returned handle's `pause()` stops reading both directions (`socket.pause()` +
 * `stream.pause()`) so no bytes move and no counters advance; `resume()` reverses
 * it. A pause requested before the forwarded channel has opened is honoured once it
 * does.
 */
"use strict";

const { forwardOut } = require("./ssh-chain");

/**
 * Start relaying `socket` to `destination` through `client`.
 *
 * @param {object} opts
 * @param {import('ssh2').Client} opts.client       the final, ready SSH client
 * @param {import('net').Socket}  opts.socket        the accepted local socket
 * @param {{host: string, port: number}} opts.destination
 * @param {import('./stats').Stats} [opts.stats]  per-tunnel metrics to feed (bytes
 *        + connection open/close); omit in tests that don't assert on stats
 * @param {(counters: {bytesUp: number, bytesDown: number}) => void} [opts.onClose]
 * @param {(err: Error) => void} [opts.onError]  the forwarded channel failed to open
 * @returns {{ counters: {bytesUp: number, bytesDown: number}, close: () => void,
 *             pause: () => void, resume: () => void }}
 */
function startRelay({ client, socket, destination, stats, onClose, onError }) {
  const counters = { bytesUp: 0, bytesDown: 0 };
  let stream = null;
  let closed = false;
  let opened = false; // the forwarded channel opened (balances connOpened/connClosed)
  let paused = false;

  // Apply the current pause state to whichever ends exist. Re-applied after the
  // pipes are wired, because `socket.pipe(stream)` resumes a paused socket.
  const applyFlow = () => {
    if (closed) return;
    try {
      if (paused) socket.pause();
      else socket.resume();
    } catch {
      // socket already gone
    }
    if (stream) {
      try {
        if (paused) stream.pause();
        else stream.resume();
      } catch {
        // stream already gone
      }
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      socket.destroy();
    } catch {
      // already gone
    }
    try {
      if (stream) stream.destroy();
    } catch {
      // already gone
    }
    if (opened) stats?.connClosed();
    onClose?.(counters);
  };

  forwardOut(
    client,
    socket.remoteAddress || "127.0.0.1",
    socket.remotePort || 0,
    destination.host,
    destination.port,
  )
    .then((s) => {
      if (closed) {
        // The local socket already went away before the channel opened.
        try {
          s.destroy();
        } catch {
          // ignore
        }
        return;
      }
      stream = s;
      opened = true;
      stats?.connOpened();

      // Up = client → destination (bytes the local socket sends).
      socket.on("data", (chunk) => {
        counters.bytesUp += chunk.length;
        stats?.addUp(chunk.length);
      });
      // Down = destination → client (bytes arriving from the SSH channel).
      stream.on("data", (chunk) => {
        counters.bytesDown += chunk.length;
        stats?.addDown(chunk.length);
      });

      socket.pipe(stream);
      stream.pipe(socket);

      socket.on("close", finish);
      socket.on("error", finish);
      stream.on("close", finish);
      stream.on("error", finish);

      if (paused) applyFlow(); // honour a pause requested before the channel opened
    })
    .catch((err) => {
      if (closed) return;
      closed = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      onError?.(err);
      onClose?.(counters);
    });

  return {
    counters,
    close: finish,
    pause: () => {
      paused = true;
      applyFlow();
    },
    resume: () => {
      paused = false;
      applyFlow();
    },
  };
}

module.exports = { startRelay };
