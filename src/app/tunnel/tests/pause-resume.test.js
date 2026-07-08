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
 * pause-resume.test.js — Feature 30 pause/resume, driven end-to-end through the
 * shared in-process harness (real ssh2 server + echo destination + a genuine local
 * socket). Asserts the settled pause semantics: pausing an active tunnel freezes
 * byte flow and stops accepting new connections **without** dropping the SSH
 * connection, its totals freeze while paused, resuming restores flow, and a paused
 * tunnel can still be disarmed cleanly. A final engine-level test confirms the
 * `porthippo:stats` snapshot reports the paused state.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TunnelEngine } = require("../engine");
const {
  delay,
  waitFor,
  freePort,
  connectLocal,
  roundtrip,
  startEcho,
  startSsh,
  makeDef,
  makeTunnel,
  fakeStores,
} = require("./harness");

// Collect data that arrives on a socket into a growing string.
function collect(sock) {
  const box = { text: "" };
  sock.on("data", (d) => (box.text += d.toString()));
  return box;
}

test("pause freezes traffic and new connects while keeping SSH up; resume restores flow", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel, states } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60000 }, // long linger: no idle teardown interferes with the test
  );

  try {
    await tunnel.arm();
    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "one"), "one");
    assert.equal(tunnel.state, "connected");
    assert.equal(ssh.active(), 1);

    const frozen = tunnel.statsSnapshot().totalBytes;
    assert.ok(frozen > 0, "some bytes were counted before pausing");

    // ── Pause ──────────────────────────────────────────────────────────────
    tunnel.pause();
    assert.equal(tunnel.state, "paused");
    assert.equal(ssh.active(), 1, "pause keeps the SSH connection alive");

    // Bytes written while paused do not flow (nothing echoes back), and the
    // frozen totals do not advance.
    const box = collect(client);
    client.write("paused-bytes");
    await delay(150);
    assert.equal(box.text, "", "no bytes flow while paused");
    assert.equal(
      tunnel.statsSnapshot().totalBytes,
      frozen,
      "totals freeze while paused",
    );

    // A new local connection is refused (accepted by the OS, then destroyed).
    const rejected = await connectLocal(localPort);
    let rejectedClosed = false;
    rejected.on("close", () => (rejectedClosed = true));
    await waitFor(() => rejectedClosed || rejected.destroyed);

    // ── Resume ─────────────────────────────────────────────────────────────
    tunnel.resume();
    assert.equal(tunnel.state, "connected");
    assert.equal(
      ssh.active(),
      1,
      "resume did not reconnect — SSH never dropped",
    );

    // The bytes buffered during the pause now flow through and echo back.
    await waitFor(() => box.text === "paused-bytes");
    assert.ok(
      tunnel.statsSnapshot().totalBytes > frozen,
      "totals advance again after resume",
    );

    // A fresh roundtrip also works post-resume.
    assert.equal(await roundtrip(client, "again"), "again");

    assert.ok(states.includes("paused"), "a paused state was broadcast");
    client.destroy();
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("a paused tunnel can still be disarmed, which tears SSH down cleanly", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 60000 },
  );

  try {
    await tunnel.arm();
    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "hi"), "hi");
    assert.equal(ssh.active(), 1);

    tunnel.pause();
    assert.equal(tunnel.state, "paused");

    await tunnel.disarm();
    assert.equal(tunnel.state, "disarmed");
    await waitFor(() => ssh.active() === 0);
  } finally {
    await tunnel.dispose();
    await ssh.close();
    await echo.close();
  }
});

test("engine pause/resume delegate and the porthippo:stats snapshot reports paused", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const def = makeDef({ localPort, echoPort: echo.port, sshPort: ssh.port });

  const events = [];
  const engine = new TunnelEngine({
    getStores: () => fakeStores([def], { defaultLingerMs: 60000 }),
    // Record every broadcast; auto-accept the (expected) unknown host key so the
    // lazy SSH connect completes without a real user prompt.
    broadcast: (channel, payload) => {
      events.push({ channel, payload });
      if (channel === "porthippo:hostkey-unknown")
        engine.trustHostKey(payload.promptId);
    },
    knownHostsFile: "/nonexistent/known_hosts",
  });

  const latestStatsFor = (id) => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].channel !== "porthippo:stats") continue;
      const snap = events[i].payload.find((s) => s.id === id);
      if (snap) return snap;
    }
    return null;
  };

  try {
    await engine.arm(def.id);
    const client = await connectLocal(localPort);
    assert.equal(await roundtrip(client, "hello"), "hello");

    // A stats snapshot with live totals is being broadcast for the tunnel.
    await waitFor(() => {
      const s = latestStatsFor(def.id);
      return s && s.totalBytes > 0;
    });

    const paused = engine.pause(def.id);
    assert.equal(paused.state, "paused");

    // The immediate on-state-change snapshot reflects the paused state.
    const snap = latestStatsFor(def.id);
    assert.equal(snap.state, "paused");
    assert.ok(snap.totalBytes > 0, "totals are carried in the snapshot");
    assert.equal(typeof snap.rateUp, "number");
    assert.equal(typeof snap.rateDown, "number");

    const resumed = engine.resume(def.id);
    assert.equal(resumed.state, "connected");
    client.destroy();
  } finally {
    await engine.disarmAll();
    await ssh.close();
    await echo.close();
  }
});
