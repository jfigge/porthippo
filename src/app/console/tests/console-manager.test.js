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
 * console-manager.test.js — end-to-end console session tests against an in-process
 * ssh2 server with an echo shell (harness `startSsh({ shell: true })`). Proves the
 * ConsoleManager + ConsoleSession connect the chain, open a shell, relay bytes both
 * ways, resize, and tear down — reusing the same connectChain the tunnel engine uses.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const { ConsoleManager } = require("../console-manager");
const {
  startSsh,
  sshHop,
  waitFor,
  freePort,
} = require("../../tunnel/tests/harness");

// A host-key mediator stand-in that trusts every hop (the real TOFU path is
// covered by host-key-mediator.test.js + host-verifier.test.js).
const trustHostKeys = {
  buildVerifier: () => (_key, verify) => verify(true),
};

function fakeStores(def) {
  return {
    consoleStore: () => ({
      getDecrypted: (id) => (id === def.id ? def : null),
      get: (id) => (id === def.id ? { id, name: def.name } : null),
    }),
  };
}

/** Concatenate every console:data payload (Uint8Array) sent to the window. */
function decodeSent(sent) {
  return sent
    .filter((m) => m.channel === "console:data")
    .map((m) => Buffer.from(m.payload.data).toString("utf8"))
    .join("");
}

function makeManager(def, sinks) {
  return new ConsoleManager({
    getStores: () => fakeStores(def),
    broadcast: (channel, payload) => {
      if (channel === "jumphippo:console-state") sinks.states.push(payload);
    },
    hostKeys: trustHostKeys,
    keyReader: fs.readFileSync,
    getSshKeepaliveMs: () => 0,
    openWindow: (sessionId, meta) => sinks.opened.push({ sessionId, meta }),
    sendToWindow: (sessionId, channel, payload) =>
      sinks.sent.push({ sessionId, channel, payload }),
  });
}

test("a console session relays a remote shell end-to-end", async () => {
  const ssh = await startSsh({ shell: true });
  const def = {
    id: "c1",
    name: "test console",
    sshServer: sshHop(ssh.port),
    jumps: [],
  };
  const sinks = { states: [], opened: [], sent: [] };
  const manager = makeManager(def, sinks);

  const { sessionId } = manager.open("c1");
  assert.equal(sinks.opened.length, 1);
  assert.equal(sinks.opened[0].sessionId, sessionId);
  assert.equal(sinks.opened[0].meta.title, "test console");

  // The window signals ready → the session connects and opens the shell.
  manager.ready(sessionId, { cols: 80, rows: 24 });
  await waitFor(() => sinks.states.some((s) => s.state === "connected"), {
    timeout: 5000,
  });
  assert.equal(manager.sessions().length, 1);

  // A keystroke round-trips through the echo shell back to the window.
  manager.input(sessionId, "hello\n");
  await waitFor(() => decodeSent(sinks.sent).includes("hello"), {
    timeout: 5000,
  });

  // Resize is best-effort and must not throw.
  manager.resize(sessionId, 100, 40);

  // Closing tears the session down and drops it from the registry.
  manager.close(sessionId);
  assert.equal(manager.sessions().length, 0);
  assert.ok(sinks.states.some((s) => s.state === "closed"));

  await ssh.close();
});

test("opening an unknown console throws NOT_FOUND", () => {
  const manager = makeManager(
    { id: "known", name: "x", sshServer: sshHop(1), jumps: [] },
    { states: [], opened: [], sent: [] },
  );
  assert.throws(() => manager.open("missing"), /console not found/);
});

test("a failed connect ends the session with an error", async () => {
  const deadPort = await freePort(); // nothing listening → connect refused
  const def = {
    id: "c2",
    name: "bad",
    sshServer: sshHop(deadPort),
    jumps: [],
  };
  const sinks = { states: [], opened: [], sent: [] };
  const manager = makeManager(def, sinks);

  const { sessionId } = manager.open("c2");
  manager.ready(sessionId, { cols: 80, rows: 24 });

  await waitFor(() => sinks.states.some((s) => s.state === "error"), {
    timeout: 5000,
  });
  // The window is told the session closed with an error, and it's dropped.
  assert.ok(
    sinks.sent.some((m) => m.channel === "console:closed" && m.payload.error),
  );
  assert.equal(manager.sessions().length, 0);
});
