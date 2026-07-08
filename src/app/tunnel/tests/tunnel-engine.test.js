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
 * tunnel-engine.test.js — integration tests for the SSH tunnel engine.
 *
 * Each test spins up an in-process `ssh2` server (password auth, implementing
 * `direct-tcpip` forwarding) plus a plain TCP echo server as the destination, then
 * drives a real local socket through the tunnel and asserts end-to-end behaviour:
 * lazy connect, byte relay, idle teardown, multi-hop chaining, host-key TOFU,
 * EADDRINUSE handling, and the reconcile (pending / force-apply) flow.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

const { TunnelEngine } = require("../engine");
const {
  delay,
  waitFor,
  listen,
  closeServer,
  freePort,
  connectLocal,
  connectLocalRetry,
  roundtrip,
  startEcho,
  startSsh,
  sshHop,
  makeDef,
  makeTunnel,
  fakeStores,
} = require("./harness");

// ── Tests ───────────────────────────────────────────────────────────────────────

test("arming binds the listener but does NOT connect SSH until first access", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
  );
  try {
    await tunnel.arm();
    assert.equal(tunnel.state, "listening");
    await delay(60);
    assert.equal(
      ssh.total(),
      0,
      "SSH must stay disconnected before first access",
    );

    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "hello"), "hello");
    assert.equal(tunnel.state, "connected");
    assert.equal(ssh.total(), 1);
    client.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("idle teardown drops SSH after linger while the listener stays bound", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60 },
  );
  try {
    await tunnel.arm();

    const c1 = await connectLocal(localPort);
    assert.equal(await roundtrip(c1, "one"), "one");
    assert.equal(ssh.active(), 1);
    c1.destroy();

    // After the linger elapses, the SSH connection is torn down...
    await waitFor(() => ssh.active() === 0);
    assert.equal(tunnel.state, "listening");

    // ...but the listener is still bound, so a new access re-opens SSH.
    const c2 = await connectLocal(localPort);
    assert.equal(await roundtrip(c2, "two"), "two");
    assert.equal(ssh.total(), 2);
    c2.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("keepAlive connects eagerly on arm and never idle-tears-down", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({
      localPort,
      echoPort: echo.port,
      sshPort: ssh.port,
      keepAlive: true,
    }),
    { lingerMs: 40 },
  );
  try {
    await tunnel.arm();
    await waitFor(() => tunnel.state === "connected"); // eager connect, no client yet
    assert.equal(ssh.total(), 1);
    await delay(120); // well past the linger
    assert.equal(
      ssh.active(),
      1,
      "keepAlive holds the SSH connection open when idle",
    );
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("a two-hop jump chain relays end-to-end", async () => {
  const echo = await startEcho();
  const jump = await startSsh();
  const final = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({
      localPort,
      echoPort: echo.port,
      sshPort: final.port,
      jumps: [sshHop(jump.port)],
    }),
  );
  try {
    await tunnel.arm();
    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "chain"), "chain");
    assert.equal(jump.total(), 1);
    assert.equal(final.total(), 1);
    client.destroy();
  } finally {
    await tunnel.dispose();
    await final.close();
    await jump.close();
    await echo.close();
  }
});

test("EADDRINUSE surfaces as an error state, not a crash", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const blocker = net.createServer();
  const localPort = await listen(blocker); // occupy the port first
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
  );
  try {
    const status = await tunnel.arm();
    assert.equal(status.state, "error");
    assert.match(status.error, /in use/);
  } finally {
    await tunnel.dispose();
    await closeServer(blocker);
    await ssh.close();
    await echo.close();
  }
});

test("a connection-affecting edit while connected is pending, then auto-applies on idle", async () => {
  const echoPlain = await startEcho();
  const echoUpper = await startEcho({
    transform: (d) => Buffer.from(d.toString().toUpperCase()),
  });
  const ssh = await startSsh();
  const localPort = await freePort();
  const def1 = makeDef({
    localPort,
    echoPort: echoPlain.port,
    sshPort: ssh.port,
  });
  const def2 = {
    ...def1,
    destination: { host: "127.0.0.1", port: echoUpper.port },
  };
  const { tunnel } = makeTunnel(def1, { lingerMs: 40 });
  try {
    await tunnel.arm();
    const c1 = await connectLocal(localPort);
    assert.equal(await roundtrip(c1, "hi"), "hi"); // plain echo (old dest)

    tunnel.applyDefinition(def2);
    assert.equal(tunnel.status().pendingChanges, true);
    // The live connection keeps serving the old destination.
    assert.equal(await roundtrip(c1, "yo"), "yo");
    c1.destroy();

    // Once idle, the pending edit auto-applies (new destination = uppercase echo).
    await waitFor(() => tunnel.status().pendingChanges === false);
    const c2 = await connectLocalRetry(localPort);
    assert.equal(await roundtrip(c2, "hello"), "HELLO");
    c2.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echoUpper.close();
    await echoPlain.close();
  }
});

test("force-apply applies a pending edit immediately, dropping live connections", async () => {
  const echoPlain = await startEcho();
  const echoUpper = await startEcho({
    transform: (d) => Buffer.from(d.toString().toUpperCase()),
  });
  const ssh = await startSsh();
  const localPort = await freePort();
  const def1 = makeDef({
    localPort,
    echoPort: echoPlain.port,
    sshPort: ssh.port,
  });
  const def2 = {
    ...def1,
    destination: { host: "127.0.0.1", port: echoUpper.port },
  };
  const { tunnel } = makeTunnel(def1);
  try {
    await tunnel.arm();
    const c1 = await connectLocal(localPort);
    assert.equal(await roundtrip(c1, "hi"), "hi");
    let c1Closed = false;
    c1.on("close", () => {
      c1Closed = true;
    });

    tunnel.applyDefinition(def2);
    assert.equal(tunnel.status().pendingChanges, true);

    tunnel.forceApply();
    await waitFor(() => c1Closed); // the live connection was force-dropped
    assert.equal(tunnel.status().pendingChanges, false);

    const c2 = await connectLocalRetry(localPort);
    assert.equal(await roundtrip(c2, "hello"), "HELLO"); // new destination applied
    c2.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echoUpper.close();
    await echoPlain.close();
  }
});

// ── Engine-level tests (arm/status + host-key TOFU) ──────────────────────────────

test("engine armAll arms enabled definitions and skips disabled ones", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const enabled = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: ssh.port,
  });
  const disabled = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: ssh.port,
    enabled: false,
  });
  const engine = new TunnelEngine({
    getStores: () => fakeStores([enabled, disabled]),
    broadcast: () => {},
    knownHostsFile: "/nonexistent/known_hosts",
  });
  try {
    await engine.armAll();
    const status = engine.status();
    const armed = status.find((s) => s.id === enabled.id);
    assert.ok(armed, "enabled definition is tracked");
    assert.equal(armed.state, "listening");
    assert.ok(
      !status.find((s) => s.id === disabled.id),
      "disabled definition is not armed",
    );
    assert.equal(
      ssh.total(),
      0,
      "armAll binds listeners but does not connect SSH",
    );
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});

test("an unknown host key holds the connection pending until the user trusts it", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const def = makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port });

  const trusted = [];
  const events = [];
  const engine = new TunnelEngine({
    getStores: () => ({
      tunnelStore: () => ({
        getDecrypted: () => def,
        listDecrypted: () => [def],
      }),
      knownHostsStore: () => ({
        get: () => null,
        trust: (hostPort, fingerprint) =>
          trusted.push({ hostPort, fingerprint }),
      }),
      settingsStore: () => ({ get: () => ({ defaultLingerMs: 10000 }) }),
    }),
    broadcast: (channel, payload) => events.push({ channel, payload }),
    knownHostsFile: "/nonexistent/known_hosts", // → every key is unknown
  });

  try {
    await engine.arm(def.id);
    const client = await connectLocal(localPort); // triggers the lazy connect + prompt

    await waitFor(() =>
      events.some((e) => e.channel === "porthippo:hostkey-unknown"),
    );
    const prompt = events.find(
      (e) => e.channel === "porthippo:hostkey-unknown",
    ).payload;
    assert.ok(prompt.promptId);
    assert.match(prompt.fingerprint, /^SHA256:/);
    assert.equal(
      ssh.total(),
      1,
      "the SSH handshake is in-flight, held pending",
    );

    // The user trusts it → the connection completes and bytes flow.
    engine.trustHostKey(prompt.promptId);
    assert.equal(await roundtrip(client, "trusted"), "trusted");
    assert.equal(trusted.length, 1, "the trust was persisted");
    assert.equal(trusted[0].fingerprint, prompt.fingerprint);
    client.destroy();
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});
