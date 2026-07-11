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
 * relay.test.js — focused unit tests for `startRelay`.
 *
 * These drive the relay with a fake SSH `client` whose `forwardOut` callback the
 * test invokes by hand, so the exact moment the forwarded `direct-tcpip` channel
 * "opens" is deterministic. That makes the otherwise timing-dependent
 * channel-open window — where the local socket can close before the channel is
 * ready — testable without racing a real ssh2 handshake.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { startRelay } = require("../relay");

// `forwardOut` resolves through a real Promise, so the relay's channel-open `.then`
// runs on a microtask. Flush it before asserting on post-open state.
const tick = () => new Promise((resolve) => setImmediate(resolve));

// A minimal local-socket stand-in: an EventEmitter with the surface `startRelay`
// touches. `destroy()` flips `destroyed` and emits `close` once (like a real
// net.Socket), which is how a test simulates the client dropping.
function fakeSocket() {
  const s = new EventEmitter();
  s.remoteAddress = "127.0.0.1";
  s.remotePort = 54321;
  s.destroyed = false;
  s.destroy = () => {
    if (s.destroyed) return;
    s.destroyed = true;
    s.emit("close");
  };
  s.pause = () => {};
  s.resume = () => {};
  s.pipe = () => {};
  return s;
}

// The forwarded channel stand-in (what `client.forwardOut` yields on success).
function fakeStream() {
  const st = new EventEmitter();
  st.destroyed = false;
  st.destroy = () => {
    if (st.destroyed) return;
    st.destroyed = true;
    st.emit("close");
  };
  st.pipe = () => {};
  st.pause = () => {};
  st.resume = () => {};
  return st;
}

// A fake SSH client that stashes the `forwardOut` callback so the test decides
// when (and whether) the channel opens.
function fakeClient() {
  let cb = null;
  return {
    forwardOut: (_srcHost, _srcPort, _dstHost, _dstPort, callback) => {
      cb = callback;
    },
    openChannel: (stream) => cb(null, stream),
    failChannel: (err) => cb(err),
  };
}

function fakeStats() {
  return {
    opened: 0,
    closed: 0,
    up: 0,
    down: 0,
    connOpened() {
      this.opened += 1;
    },
    connClosed() {
      this.closed += 1;
    },
    addUp(n) {
      this.up += n;
    },
    addDown(n) {
      this.down += n;
    },
  };
}

test("local socket closing during the channel-open window fires onClose exactly once and drops the channel", async () => {
  const socket = fakeSocket();
  const client = fakeClient();
  const stats = fakeStats();
  let closeCount = 0;

  startRelay({
    client,
    socket,
    destination: { host: "127.0.0.1", port: 9 },
    stats,
    onClose: () => {
      closeCount += 1;
    },
  });

  // The forwarded channel has NOT opened yet (client.openChannel not called).
  // The client drops mid-open — the window the bug lived in.
  socket.destroy();

  // With the fix, onClose fired immediately from the socket-close handler wired
  // before forwardOut; the old code missed this close entirely (0 calls).
  assert.equal(
    closeCount,
    1,
    "onClose fired once when the socket closed early",
  );
  assert.equal(stats.opened, 0, "the channel never opened, so no connOpened");
  assert.equal(stats.closed, 0, "and no connClosed to balance a never-open");

  // The channel now opens late: it must be discarded, not leaked or piped.
  const stream = fakeStream();
  client.openChannel(stream);
  await tick();
  assert.equal(stream.destroyed, true, "the late channel is destroyed");
  assert.equal(closeCount, 1, "onClose is not fired a second time");
});

test("normal open → data → close balances stats and fires onClose once", async () => {
  const socket = fakeSocket();
  const client = fakeClient();
  const stats = fakeStats();
  let closeCount = 0;

  startRelay({
    client,
    socket,
    destination: { host: "127.0.0.1", port: 9 },
    stats,
    onClose: () => {
      closeCount += 1;
    },
  });

  // The channel opens, then bytes flow both ways.
  const stream = fakeStream();
  client.openChannel(stream);
  await tick();
  assert.equal(stats.opened, 1, "connOpened once the channel is up");

  socket.emit("data", Buffer.from("hello")); // client → destination
  stream.emit("data", Buffer.from("hi")); // destination → client
  assert.equal(stats.up, 5);
  assert.equal(stats.down, 2);

  socket.destroy(); // the client disconnects normally
  assert.equal(closeCount, 1, "onClose fired once");
  assert.equal(stats.closed, 1, "connClosed balances the connOpened");
});
