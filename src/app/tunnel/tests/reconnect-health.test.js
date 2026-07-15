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
 * reconnect-health.test.js — Feature 130: the engine surfaces (never changes) the
 * reconnect algorithm as typed lifecycle transitions, honours the settings-driven
 * retry policy + per-tunnel override, and threads the ssh2 keepalive interval.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TunnelEngine } = require("../engine");
const { clientConnectOptions } = require("../ssh-chain");
const {
  waitFor,
  freePort,
  connectLocal,
  roundtrip,
  startEcho,
  startSsh,
  makeDef,
  fakeStores,
} = require("./harness");

// Build an engine that auto-trusts every unknown host key (TOFU) so a test can
// focus on the reconnect behaviour, and captures every tunnel-state broadcast.
function trackingEngine(defs, { settings } = {}) {
  const snaps = [];
  const transitions = [];
  let engine;
  engine = new TunnelEngine({
    getStores: () => fakeStores(defs, { settings }),
    broadcast: (channel, payload) => {
      if (channel === "porthippo:hostkey-unknown") {
        engine.trustHostKey(payload.promptId);
      } else if (channel === "porthippo:tunnel-state") {
        snaps.push(payload);
        if (payload.transition) transitions.push(payload.transition);
      }
    },
    knownHostsFile: "/nonexistent/known_hosts",
  });
  const stateOf = (id) =>
    engine.status().find((s) => s.id === id)?.state || "disarmed";
  return { engine, snaps, transitions, stateOf };
}

// ── ssh2 keepalive plumbing ──────────────────────────────────────────────────

test("clientConnectOptions omits keepalive when the interval is 0 / absent", () => {
  const hop = { host: "h", port: 22, user: "me" };
  const base = clientConnectOptions({
    hop,
    authHandler: [{ type: "password" }],
    hostVerifier: () => {},
  });
  assert.equal(base.host, "h");
  assert.equal(base.port, 22);
  assert.equal(base.username, "me");
  assert.equal(base.tryKeyboard, false);
  assert.equal("keepaliveInterval" in base, false);

  const zero = clientConnectOptions({
    hop,
    authHandler: [],
    keepaliveInterval: 0,
  });
  assert.equal("keepaliveInterval" in zero, false);
});

test("clientConnectOptions enables ssh2 probing when an interval is set", () => {
  const opts = clientConnectOptions({
    hop: { host: "h", port: 22, user: "me" },
    authHandler: [],
    hostVerifier: () => {},
    keepaliveInterval: 15000,
  });
  assert.equal(opts.keepaliveInterval, 15000);
  assert.equal(opts.keepaliveCountMax, 3); // the default probe budget
});

// ── Lifecycle transitions ────────────────────────────────────────────────────

test("an unexpected drop emits dropped → reconnecting → gave-up with attempt + countdown", async () => {
  const echo = await startEcho();
  const port = await freePort();
  const ssh = await startSsh({ port }); // bind a known port so a drop = server gone
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: port,
    autoReconnect: true, // retries a bounded number of times, then gives up
  });
  const { engine, snaps, transitions, stateOf } = trackingEngine([def], {
    settings: {
      reconnectBaseMs: 5,
      reconnectMaxMs: 15,
      reconnectMaxAttempts: 3,
      sshKeepaliveSeconds: 0,
    },
  });
  try {
    await engine.arm(def.id);
    const client = await connectLocal(def.localPort); // lazy connect
    assert.equal(await roundtrip(client, "hi"), "hi");
    await waitFor(() => stateOf(def.id) === "connected");

    // Kill the server: the live connection drops and the reconnect loop runs to
    // exhaustion against the now-closed port.
    await ssh.close();
    await waitFor(() => transitions.includes("gave-up"), { timeout: 4000 });

    assert.ok(transitions.includes("dropped"), "announced the drop");
    assert.ok(transitions.includes("reconnecting"), "announced the retries");

    const reconnecting = snaps.find((s) => s.transition === "reconnecting");
    assert.ok(reconnecting.attempt >= 1, "carries the attempt count");
    assert.equal(
      typeof reconnecting.nextRetryAt,
      "number",
      "carries the countdown target",
    );
    assert.equal(stateOf(def.id), "error", "latches to error after giving up");
    client.destroy();
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});

test("a per-tunnel retry override tightens the policy the settings would allow", async () => {
  const echo = await startEcho();
  const port = await freePort();
  const ssh = await startSsh({ port });
  // Settings would retry 100× (effectively never give up within the test window);
  // the per-tunnel override caps it at a single attempt.
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: port,
    autoReconnect: true,
    retry: { maxAttempts: 1 },
  });
  const { engine, transitions, stateOf } = trackingEngine([def], {
    settings: {
      reconnectBaseMs: 20,
      reconnectMaxMs: 40,
      reconnectMaxAttempts: 100,
      sshKeepaliveSeconds: 0,
    },
  });
  try {
    await engine.arm(def.id);
    const client = await connectLocal(def.localPort);
    assert.equal(await roundtrip(client, "hi"), "hi");
    await waitFor(() => stateOf(def.id) === "connected");

    await ssh.close();
    // The override (1 attempt) gives up almost immediately; the settings' 100
    // attempts × 20ms would still be reconnecting well past this window.
    await waitFor(() => transitions.includes("gave-up"), { timeout: 1000 });
    assert.equal(stateOf(def.id), "error");
    client.destroy();
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});

test("a keepAlive tunnel that reconnects after the server returns emits recovered", async () => {
  const echo = await startEcho();
  const port = await freePort();
  let ssh = await startSsh({ port });
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: port,
    keepAlive: true, // eager connect; never gives up reconnecting
  });
  const { engine, transitions, stateOf } = trackingEngine([def], {
    settings: {
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      reconnectMaxAttempts: 3,
      sshKeepaliveSeconds: 0,
    },
  });
  let ssh2 = null;
  try {
    await engine.arm(def.id);
    await waitFor(() => stateOf(def.id) === "connected"); // eager keepAlive connect

    await ssh.close(); // drop → keepAlive retries forever at the max backoff
    await waitFor(() => transitions.includes("dropped"), { timeout: 3000 });

    // Bring the server back on the SAME port; the next attempt succeeds.
    ssh2 = await startSsh({ port });
    await waitFor(() => transitions.includes("recovered"), { timeout: 4000 });
    assert.equal(stateOf(def.id), "connected", "reconnected after recovery");
  } finally {
    await engine.disarmAll();
    if (ssh2) await ssh2.close();
    await ssh.close();
    await echo.close();
  }
});

test("a recovered notice is not emitted when the connection never dropped", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const def = makeDef({
    localPort: await freePort(),
    echoPort: echo.port,
    sshPort: ssh.port,
    keepAlive: true,
  });
  const { engine, transitions, stateOf } = trackingEngine([def], {
    settings: { sshKeepaliveSeconds: 0 },
  });
  try {
    await engine.arm(def.id);
    await waitFor(() => stateOf(def.id) === "connected");
    assert.ok(
      !transitions.includes("recovered"),
      "a first-time connect is not a recovery",
    );
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});
