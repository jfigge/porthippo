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
 * apply-to-many.test.js — Feature 140 bulk actions. `engine.applyToMany(ids,
 * action)` delegates to the per-tunnel methods but must emit exactly ONE coalesced
 * `porthippo:tunnel-state` broadcast (array payload) for the whole set, not one per
 * tunnel. Arming a local tunnel only binds its listener (no SSH connect), so these
 * tests are deterministic without a real SSH server.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { TunnelEngine } = require("../engine");
const { freePort, makeDef, fakeStores } = require("./harness");

/** An engine over N local defs that records every broadcast into `events`. */
async function makeEngineWith(n) {
  const defs = [];
  for (let i = 0; i < n; i++) {
    defs.push(
      makeDef({ localPort: await freePort(), echoPort: 1, sshPort: 1 }),
    );
  }
  const events = [];
  const engine = new TunnelEngine({
    getStores: () => fakeStores(defs, { defaultLingerMs: 60000 }),
    broadcast: (channel, payload) => events.push({ channel, payload }),
    knownHostsFile: "/nonexistent/known_hosts",
  });
  return { engine, defs, events };
}

const stateEvents = (events) =>
  events.filter((e) => e.channel === "porthippo:tunnel-state");

test("applyToMany arm emits ONE coalesced tunnel-state broadcast for the set", async () => {
  const { engine, defs, events } = await makeEngineWith(3);
  const ids = defs.map((d) => d.id);
  try {
    const before = stateEvents(events).length;
    const result = await engine.applyToMany(ids, "arm");
    const emitted = stateEvents(events).slice(before);

    assert.equal(emitted.length, 1, "exactly one tunnel-state broadcast");
    assert.ok(Array.isArray(emitted[0].payload), "payload is an array");
    assert.equal(emitted[0].payload.length, 3, "one snapshot per tunnel");
    for (const snap of emitted[0].payload) {
      assert.equal(snap.state, "listening");
      assert.ok(ids.includes(snap.id));
    }
    // The returned value is the same affected-snapshots array.
    assert.equal(result.length, 3);
  } finally {
    await engine.disarmAll();
  }
});

test("applyToMany pause toggles every armed tunnel with a single broadcast", async () => {
  const { engine, defs, events } = await makeEngineWith(3);
  const ids = defs.map((d) => d.id);
  try {
    for (const id of ids) await engine.arm(id); // individual (non-batched) arms

    const before = stateEvents(events).length;
    await engine.applyToMany(ids, "pause");
    const emitted = stateEvents(events).slice(before);

    assert.equal(
      emitted.length,
      1,
      "one coalesced broadcast, not one per tunnel",
    );
    assert.equal(emitted[0].payload.length, 3);
    for (const snap of emitted[0].payload) assert.equal(snap.state, "paused");
  } finally {
    await engine.disarmAll();
  }
});

test("applyToMany is best-effort: an unknown id is skipped, the rest still toggle", async () => {
  const { engine, defs, events } = await makeEngineWith(2);
  const ids = defs.map((d) => d.id);
  try {
    for (const id of ids) await engine.arm(id);

    const before = stateEvents(events).length;
    // A stray id has no tunnel; pause() returns a disarmed stub and emits nothing.
    await engine.applyToMany([ids[0], "no-such-id", ids[1]], "pause");
    const emitted = stateEvents(events).slice(before);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].payload.length, 2, "only the two real tunnels");
  } finally {
    await engine.disarmAll();
  }
});

test("applyToMany rejects an unknown action", async () => {
  const { engine, defs } = await makeEngineWith(1);
  try {
    await assert.rejects(
      () => engine.applyToMany([defs[0].id], "explode"),
      (e) => e.code === "INVALID_ARG",
    );
  } finally {
    await engine.disarmAll();
  }
});
