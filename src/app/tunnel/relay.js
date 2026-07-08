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
 * other. Because we own both ends of the pipe we can count every byte (Feature 30
 * reads `counters`) and tear a single connection down precisely. Either side
 * closing or erroring ends the other, and `onClose` fires exactly once so the owning
 * Tunnel can decrement its live-connection ref-count.
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
 * @param {(counters: {bytesUp: number, bytesDown: number}) => void} [opts.onClose]
 * @param {(err: Error) => void} [opts.onError]  the forwarded channel failed to open
 * @returns {{ counters: {bytesUp: number, bytesDown: number}, close: () => void }}
 */
function startRelay({ client, socket, destination, onClose, onError }) {
  const counters = { bytesUp: 0, bytesDown: 0 };
  let stream = null;
  let closed = false;

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

      // Up = client → destination (bytes the local socket sends).
      socket.on("data", (chunk) => {
        counters.bytesUp += chunk.length;
      });
      // Down = destination → client (bytes arriving from the SSH channel).
      stream.on("data", (chunk) => {
        counters.bytesDown += chunk.length;
      });

      socket.pipe(stream);
      stream.pipe(socket);

      socket.on("close", finish);
      socket.on("error", finish);
      stream.on("close", finish);
      stream.on("error", finish);
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

  return { counters, close: finish };
}

module.exports = { startRelay };
