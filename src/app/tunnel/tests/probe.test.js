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
 * probe.test.js — the resolution probe (Feature 100), driven against the same real
 * in-process ssh2 servers the engine tests use. It asserts the per-hop report, that
 * the destination is probed from the far end, that a failure stops the walk and skips
 * the rest, and — the safety contract — that a probe binds no listener, tracks no
 * tunnel, and leaves no SSH connection open.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

const { TunnelEngine } = require("../engine");
const {
  waitFor,
  closeServer,
  freePort,
  startEcho,
  startSsh,
  sshHop,
  makeDef,
  fakeStores,
} = require("./harness");

// An engine that auto-trusts every unknown host key (the probe uses the same TOFU
// path as arming), so these tests exercise the walk, not the prompt.
function makeEngine() {
  let engine;
  engine = new TunnelEngine({
    getStores: () => fakeStores([]),
    broadcast: (channel, payload) => {
      if (channel === "porthippo:hostkey-unknown") {
        engine.trustHostKey(payload.promptId);
      }
    },
    knownHostsFile: "/nonexistent/known_hosts", // → every key is unknown
  });
  return engine;
}

const byLabel = (hops, label) => hops.find((h) => h.hopLabel === label);

test("a single-hop probe reports the sshServer and destination as reachable", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const engine = makeEngine();
  const def = makeDef({
    localPort: 5555,
    echoPort: echo.port,
    sshPort: ssh.port,
  });
  try {
    const result = await engine.probeDefinition(def);
    assert.equal(result.ok, true);
    assert.equal(result.hops.length, 1);
    assert.equal(byLabel(result.hops, "sshServer").status, "ok");
    assert.equal(result.destination.status, "ok");
    assert.equal(result.destination.port, echo.port);

    // Safety contract: no listener bound, no tunnel tracked, no SSH left open.
    assert.equal(engine.status().length, 0, "probe tracks no tunnel");
    await waitFor(() => ssh.active() === 0);
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(5555, "127.0.0.1", resolve); // free ⇒ the probe bound nothing
    });
    await closeServer(probe);
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});

test("a two-hop chain reports both hops ok and connects through each", async () => {
  const echo = await startEcho();
  const jump = await startSsh();
  const final = await startSsh();
  const engine = makeEngine();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: final.port,
    jumps: [sshHop(jump.port)],
  });
  try {
    const result = await engine.probeDefinition(def);
    assert.equal(result.ok, true);
    assert.equal(byLabel(result.hops, "jump[0]").status, "ok");
    assert.equal(byLabel(result.hops, "sshServer").status, "ok");
    assert.equal(result.destination.status, "ok");
    assert.equal(jump.total(), 1);
    assert.equal(final.total(), 1);
  } finally {
    await engine.disarmAll();
    await final.close();
    await jump.close();
    await echo.close();
  }
});

test("an unreachable destination fails only the destination, hops still ok", async () => {
  const echo = await startEcho();
  const ssh = await startSsh({ rejectForward: true }); // the far side refuses the forward
  const engine = makeEngine();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: ssh.port,
  });
  try {
    const result = await engine.probeDefinition(def);
    assert.equal(result.ok, false);
    assert.equal(byLabel(result.hops, "sshServer").status, "ok");
    assert.equal(result.destination.status, "fail");
    assert.match(result.destination.reason, /\S/);
    await waitFor(() => ssh.active() === 0); // still disposed on a destination failure
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});

test("a hop that can't be reached from the previous one fails and skips the rest", async () => {
  const echo = await startEcho();
  const jump = await startSsh({ rejectForward: true }); // can't forward on to the final hop
  const final = await startSsh();
  const engine = makeEngine();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: final.port,
    jumps: [sshHop(jump.port)],
  });
  try {
    const result = await engine.probeDefinition(def);
    assert.equal(result.ok, false);
    assert.equal(byLabel(result.hops, "jump[0]").status, "ok");
    const sshServer = byLabel(result.hops, "sshServer");
    assert.equal(sshServer.status, "fail");
    assert.match(sshServer.reason, /\S/);
    assert.equal(result.destination.status, "skipped");
    assert.equal(final.total(), 0, "the final hop was never reached");
    await waitFor(() => jump.active() === 0);
  } finally {
    await engine.disarmAll();
    await final.close();
    await jump.close();
    await echo.close();
  }
});

test("an unreachable SSH server fails that hop and skips the destination", async () => {
  const echo = await startEcho();
  const closedPort = await freePort(); // nothing is listening here
  const engine = makeEngine();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: closedPort,
  });
  try {
    const result = await engine.probeDefinition(def);
    assert.equal(result.ok, false);
    assert.equal(byLabel(result.hops, "sshServer").status, "fail");
    assert.equal(result.destination.status, "skipped");
  } finally {
    await engine.disarmAll();
    await echo.close();
  }
});

test("an aborted probe connects nothing and reports every step skipped", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const engine = makeEngine();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: ssh.port,
  });
  try {
    const controller = new AbortController();
    controller.abort(); // cancelled before it starts
    const result = await engine.probeDefinition(def, {
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(byLabel(result.hops, "sshServer").status, "skipped");
    assert.equal(result.destination.status, "skipped");
    assert.equal(ssh.total(), 0, "an aborted probe opens no SSH connection");
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});
