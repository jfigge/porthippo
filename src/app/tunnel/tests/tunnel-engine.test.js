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
  gatedVerifier,
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

test("disarm during an in-flight connect never resurrects or leaks the SSH connection", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();

  // Hold the handshake pending at host verification so we can disarm mid-connect.
  const gate = gatedVerifier();
  const { tunnel, states } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60000, hostVerifierFactory: gate.factory },
  );

  try {
    await tunnel.arm();
    const client = await connectLocal(localPort); // triggers the lazy connect
    await waitFor(() => tunnel.state === "connecting");

    // Disarm while the connect is still gated: teardown must invalidate it.
    await tunnel.disarm();
    assert.equal(tunnel.state, "disarmed");

    // Let the gated handshake complete. The connect resolves AFTER the disarm —
    // the bug was that its .then re-established #sshConnection and drove the
    // tunnel back to "connected". With the generation guard it is a no-op.
    gate.release();
    await waitFor(() => ssh.active() === 0);

    assert.equal(
      tunnel.state,
      "disarmed",
      "stays disarmed after the late connect",
    );
    assert.ok(
      !states.includes("connected"),
      "never reaches connected once disarmed",
    );
    assert.equal(ssh.active(), 0, "no SSH connection leaks past the disarm");

    client.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("a local socket error during the connect/TOFU window is absorbed, not fatal", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();

  // Gate the handshake at host verification so the relay is never created — the
  // accepted socket therefore has no relay-owned `error` handler yet, which is the
  // exact window the bug lived in.
  const gate = gatedVerifier();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60000, hostVerifierFactory: gate.factory },
  );

  try {
    await tunnel.arm();
    const client = await connectLocal(localPort); // triggers the lazy connect
    await waitFor(() => tunnel.state === "connecting");

    // Force an RST so the server-side accepted socket raises `error` (ECONNRESET),
    // not a clean `close`. Before the fix this was an unhandled 'error' event that
    // took down the whole main process (killing every other tunnel). Reaching the
    // assertions below at all proves the error was absorbed.
    client.resetAndDestroy();
    await delay(60);

    assert.ok(
      ["connecting", "listening", "connected"].includes(tunnel.state),
      "tunnel survives the pre-relay socket error",
    );

    // The tunnel is still fully usable afterwards: release the gate and a fresh
    // client relays end-to-end.
    gate.release();
    const client2 = await connectLocalRetry(localPort);
    assert.equal(await roundtrip(client2, "after-reset"), "after-reset");
    client2.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("arm() racing dispose() never leaks a bound listener", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
  );
  try {
    // Start the bind, then dispose while it is still in flight (#listener is not
    // yet assigned, so #teardown can't see the socket now finishing its bind).
    const arming = tunnel.arm();
    await tunnel.dispose();
    await arming;
    assert.equal(tunnel.state, "disarmed");

    // The port must be free — a leaked listener bound onto the disposed tunnel
    // would still hold it and this rebind would throw EADDRINUSE.
    const probe = net.createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(localPort, "127.0.0.1", resolve);
    });
    await closeServer(probe);
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("a failed forward surfaces an error instead of silently staying connected", async () => {
  const echo = await startEcho();
  const ssh = await startSsh({ rejectForward: true }); // every forward is refused
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60000 }, // don't let idle teardown race the assertion
  );
  try {
    await tunnel.arm();
    const client = await connectLocal(localPort); // connects SSH, then the forward is rejected

    // The forwarded channel fails to open → the relay reports it → the tunnel
    // records a visible error rather than sitting silently "connected".
    await waitFor(() => Boolean(tunnel.status().error));
    assert.match(tunnel.status().error, /\S/);
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

test("keepAlive keeps retrying after backoff exhaustion instead of giving up", async () => {
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
    // Tiny backoff so several attempts (and exhaustion) elapse well under 200ms.
    {
      lingerMs: 60000,
      baseBackoffMs: 5,
      maxBackoffMs: 15,
      maxReconnectAttempts: 3,
    },
  );
  try {
    await tunnel.arm();
    await waitFor(() => tunnel.state === "connected"); // eager keepAlive connect

    // Kill the SSH server: the live connection drops and the reconnect loop
    // begins, then exhausts its attempts against the now-closed port.
    await ssh.close();

    // Old behaviour latched to a permanent "error" after exhaustion; keepAlive
    // must instead keep trying, so it stays in the reconnect loop ("connecting").
    await delay(200);
    assert.notEqual(tunnel.state, "error", "keepAlive never latches to error");
    assert.equal(tunnel.state, "connecting", "keepAlive is still retrying");
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
    // The bind failure is logged to the error history the "Errors" card opens.
    const log = tunnel.events();
    assert.equal(log.length, 1);
    assert.equal(log[0].level, "error");
    assert.match(log[0].message, /in use/);
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

    const applied = tunnel.forceApply();
    assert.equal(
      typeof applied?.then,
      "function",
      "forceApply returns an awaitable so a caller sees the settled state",
    );
    await applied; // the teardown + re-arm has settled once this resolves
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

test("disarm with a pending edit stays disarmed instead of reentrantly re-arming", async () => {
  // Regression: disarm() nulled #pendingDef AFTER #teardown(). Tearing down the live
  // relay fires its onClose synchronously → #onIdleCheck() → #maybeApplyPending(),
  // which used the still-set pending def to #reapply() (re-arm) the very tunnel being
  // disarmed, leaving a fresh listener bound. Disarm must win: end disarmed, port
  // unbound, no pending edit surviving.
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

    tunnel.applyDefinition(def2); // connection-affecting edit → stashed as pending
    assert.equal(tunnel.status().pendingChanges, true);

    // Disarm while the connection is STILL live, so teardown is what closes the
    // relay (and thus what fires the reentrant idle check).
    await tunnel.disarm();
    await delay(100); // give any (buggy) floating reapply a chance to re-bind
    assert.equal(tunnel.state, "disarmed", "disarm must stick");
    assert.equal(
      tunnel.status().pendingChanges,
      false,
      "the pending edit is discarded, not applied",
    );
    await assert.rejects(
      () => connectLocal(localPort),
      "the local port is no longer bound",
    );
    c1.destroy();
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

test("re-arming a tunnel stuck in error (transient bind conflict) recovers it", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const blocker = net.createServer();
  const localPort = await listen(blocker); // occupy the port so the first arm fails
  const def = makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port });
  // The engine uses the real host-verifier against a nonexistent known_hosts, so
  // the first byte access would hold pending on an unknown key. This test is about
  // re-arm recovery, not TOFU, so auto-trust any unknown key the moment it prompts.
  let engine;
  engine = new TunnelEngine({
    getStores: () => fakeStores([def]),
    broadcast: (channel, payload) => {
      if (channel === "porthippo:hostkey-unknown") {
        engine.trustHostKey(payload.promptId);
      }
    },
    knownHostsFile: "/nonexistent/known_hosts",
  });
  try {
    // First arm can't bind — the port is taken — so the tunnel lands in `error`.
    const first = await engine.arm(def.id);
    assert.equal(first.state, "error");
    assert.match(first.error, /in use/);

    // Free the port and arm again. The bug was that arm() short-circuited on the
    // non-disarmed `error` state and became a permanent no-op; the retry must now
    // dispose + re-make the tunnel and actually rebind.
    await closeServer(blocker);
    const second = await engine.arm(def.id);
    assert.equal(second.state, "listening");

    // The recovered tunnel works end-to-end.
    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "recovered"), "recovered");
    client.destroy();
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
