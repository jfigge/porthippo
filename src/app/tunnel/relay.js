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
 *
 * Feature 110 adds two sibling relays that share the same byte-counting + pause
 * shape for the reverse and dynamic (SOCKS) forwarding types:
 *   - `startReverseRelay` bridges an already-accepted remote channel to a freshly
 *     dialled LOCAL target (`ssh -R`): the far end initiates, we dial inward.
 *   - `startSocksRelay` performs a SOCKS5 CONNECT handshake on the local socket
 *     (via `socks5.js`), then `forwardOut`s to the requested target (`ssh -D`).
 * In every direction we still own both ends of the pipe, so byte counting and
 * teardown stay exact.
 */
"use strict";

const net = require("net");

const { forwardOut } = require("./ssh-chain");
const {
  Socks5Handshake,
  replyBuffer,
  successReply,
  forwardErrorToRep,
  REP,
} = require("./socks5");

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
 * @param {() => void} [opts.onOpen]  the forwarded channel opened (a forward succeeded)
 * @returns {{ counters: {bytesUp: number, bytesDown: number}, close: () => void,
 *             pause: () => void, resume: () => void }}
 */
function startRelay({
  client,
  socket,
  destination,
  stats,
  onClose,
  onError,
  onOpen,
}) {
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

  // Wire the local socket's teardown up front — BEFORE `forwardOut` resolves.
  // If the client drops during the channel-open window, `finish()` runs now
  // (firing `onClose` exactly once) instead of the close being missed: otherwise
  // the pending forwarded channel leaks and the owning Tunnel's ref-count never
  // reaches zero, so its SSH connection would never idle-tear-down.
  socket.on("close", finish);
  socket.on("error", finish);

  forwardOut(
    client,
    socket.remoteAddress || "127.0.0.1",
    socket.remotePort || 0,
    destination.host,
    destination.port,
  )
    .then((s) => {
      if (closed) {
        // The local socket already went away before (or during) the channel
        // open — `finish()` has already fired `onClose`. Just drop the now-
        // orphaned forwarded channel so it doesn't leak.
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
      onOpen?.();

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

      // The local socket's close/error are already wired (above); wire the
      // forwarded channel's so either end ending tears the other down.
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

/**
 * Reverse relay (`ssh -R`, Feature 110): bridge an already-accepted remote channel
 * to a freshly dialled LOCAL target. The far-end SSH server accepted an inbound
 * connection on our forwarded port and handed us `stream`; we dial `destination`
 * on this machine and pipe the two together. Direction: `up` = bytes our local
 * service sends toward the remote client, `down` = bytes arriving from it.
 *
 * @param {object} opts
 * @param {import('ssh2').Channel} opts.stream  the accepted remote channel
 * @param {{host: string, port: number}} opts.destination  the local target to dial
 * @param {import('./stats').Stats} [opts.stats]
 * @param {(counters: {bytesUp: number, bytesDown: number}) => void} [opts.onClose]
 * @param {(err: Error) => void} [opts.onError]  the local dial failed
 * @param {() => void} [opts.onOpen]  the local connection opened
 * @returns {{ counters: object, close: () => void, pause: () => void, resume: () => void }}
 */
function startReverseRelay({
  stream,
  destination,
  stats,
  onClose,
  onError,
  onOpen,
}) {
  const counters = { bytesUp: 0, bytesDown: 0 };
  let socket = null;
  let closed = false;
  let opened = false;
  let paused = false;

  const applyFlow = () => {
    if (closed) return;
    try {
      if (paused) stream.pause();
      else stream.resume();
    } catch {
      // stream already gone
    }
    if (socket) {
      try {
        if (paused) socket.pause();
        else socket.resume();
      } catch {
        // socket already gone
      }
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      stream.destroy();
    } catch {
      // already gone
    }
    try {
      if (socket) socket.destroy();
    } catch {
      // already gone
    }
    if (opened) stats?.connClosed();
    onClose?.(counters);
  };

  // Wire the remote channel's teardown up front — a drop during the local dial
  // window fires `finish()` (and `onClose`) exactly once instead of leaking.
  stream.on("close", finish);
  stream.on("error", finish);

  socket = net.connect(destination.port, destination.host, () => {
    if (closed) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      return;
    }
    opened = true;
    stats?.connOpened();
    onOpen?.();

    socket.on("data", (chunk) => {
      counters.bytesUp += chunk.length;
      stats?.addUp(chunk.length);
    });
    stream.on("data", (chunk) => {
      counters.bytesDown += chunk.length;
      stats?.addDown(chunk.length);
    });

    socket.pipe(stream);
    stream.pipe(socket);
    if (paused) applyFlow();
  });

  // A single error handler covers both the pre-open dial failure (destination
  // refused/unreachable → report it) and a post-open runtime error (just finish).
  socket.on("error", (err) => {
    if (closed) return;
    if (opened) {
      finish();
      return;
    }
    closed = true;
    try {
      stream.destroy();
    } catch {
      // ignore
    }
    onError?.(err);
    onClose?.(counters);
  });
  socket.on("close", () => {
    if (opened) finish();
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

/**
 * SOCKS relay (`ssh -D`, Feature 110): run a SOCKS5 CONNECT handshake on the local
 * `socket` (no-auth only, via `socks5.js`), then `forwardOut` a `direct-tcpip`
 * channel through `client` to the requested target and pipe. The client picks the
 * destination per connection, so there is no fixed `destination`. Direction matches
 * the local relay: `up` = client → target, `down` = target → client.
 *
 * @param {object} opts
 * @param {import('ssh2').Client} opts.client  the final, ready SSH client
 * @param {import('net').Socket}  opts.socket  the accepted local SOCKS socket
 * @param {import('./stats').Stats} [opts.stats]
 * @param {(counters: {bytesUp: number, bytesDown: number}) => void} [opts.onClose]
 * @param {(err: Error) => void} [opts.onError]  the forwarded channel failed to open
 * @param {() => void} [opts.onOpen]  the forwarded channel opened
 * @returns {{ counters: object, close: () => void, pause: () => void, resume: () => void }}
 */
function startSocksRelay({ client, socket, stats, onClose, onError, onOpen }) {
  const counters = { bytesUp: 0, bytesDown: 0 };
  const hs = new Socks5Handshake();
  let stream = null;
  let closed = false;
  let opened = false;
  let paused = false;

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

  socket.on("close", finish);
  socket.on("error", finish);

  const onHandshakeData = (chunk) => {
    let res;
    try {
      res = hs.feed(chunk);
    } catch {
      res = { status: "error", rep: REP.GENERAL_FAILURE };
    }
    if (res.send) {
      try {
        socket.write(res.send);
      } catch {
        // socket gone
      }
    }
    if (res.status === "need-more") return;
    if (res.status === "error") {
      try {
        socket.write(replyBuffer(res.rep ?? REP.GENERAL_FAILURE));
      } catch {
        // socket gone
      }
      finish();
      return;
    }

    // A CONNECT request: stop reading handshake bytes and hold the socket until
    // the forwarded channel is wired, so no application bytes are lost.
    socket.off("data", onHandshakeData);
    socket.pause();
    const { dstHost, dstPort } = res.request;
    const leftover = res.leftover;

    forwardOut(
      client,
      socket.remoteAddress || "127.0.0.1",
      socket.remotePort || 0,
      dstHost,
      dstPort,
    )
      .then((s) => {
        if (closed) {
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
        try {
          socket.write(successReply());
        } catch {
          // socket gone
        }
        onOpen?.();

        socket.on("data", (c) => {
          counters.bytesUp += c.length;
          stats?.addUp(c.length);
        });
        stream.on("data", (c) => {
          counters.bytesDown += c.length;
          stats?.addDown(c.length);
        });

        // Any application bytes the client pipelined after the request come first.
        if (leftover && leftover.length) {
          counters.bytesUp += leftover.length;
          stats?.addUp(leftover.length);
          try {
            stream.write(leftover);
          } catch {
            // stream gone
          }
        }

        socket.pipe(stream); // resumes the socket we paused above
        stream.pipe(socket);
        stream.on("close", finish);
        stream.on("error", finish);
        if (paused) applyFlow();
      })
      .catch((err) => {
        if (closed) return;
        try {
          socket.write(replyBuffer(forwardErrorToRep(err)));
        } catch {
          // socket gone
        }
        closed = true;
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        onError?.(err);
        onClose?.(counters);
      });
  };

  socket.on("data", onHandshakeData);

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

module.exports = { startRelay, startReverseRelay, startSocksRelay };
