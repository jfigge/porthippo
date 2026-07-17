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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  Scheduler,
  wanted,
  inTimeWindow,
  nextTimeBoundaryMs,
  effectiveSchedule,
} = require("../scheduler");

// ── Pure evaluation: time window ──────────────────────────────────────────────

const WORK = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
const at = (day, minutes) => ({ day, minutes });

test("inTimeWindow: same-day window, days + [start,end) bounds", () => {
  assert.equal(inTimeWindow(WORK, at(1, 600)), true); // Mon 10:00
  assert.equal(inTimeWindow(WORK, at(1, 540)), true); // Mon 09:00 (inclusive)
  assert.equal(inTimeWindow(WORK, at(1, 1020)), false); // Mon 17:00 (exclusive)
  assert.equal(inTimeWindow(WORK, at(1, 1019)), true); // Mon 16:59
  assert.equal(inTimeWindow(WORK, at(1, 480)), false); // Mon 08:00
  assert.equal(inTimeWindow(WORK, at(6, 600)), false); // Sat — not a listed day
  assert.equal(inTimeWindow(WORK, at(0, 600)), false); // Sun — not a listed day
});

test("inTimeWindow: window wrapping past midnight", () => {
  const night = { days: [5], start: "22:00", end: "06:00" }; // Fri night
  assert.equal(inTimeWindow(night, at(5, 1380)), true); // Fri 23:00 (evening)
  assert.equal(inTimeWindow(night, at(6, 180)), true); // Sat 03:00 (carried over)
  assert.equal(inTimeWindow(night, at(6, 360)), false); // Sat 06:00 (exclusive)
  assert.equal(inTimeWindow(night, at(5, 1260)), false); // Fri 21:00 (before start)
  assert.equal(inTimeWindow(night, at(6, 1380)), false); // Sat 23:00 (not listed)
});

test("inTimeWindow: absent time is not a constraint; malformed never matches", () => {
  assert.equal(inTimeWindow(undefined, at(3, 0)), true);
  assert.equal(
    inTimeWindow({ days: [1], start: "09:00", end: "09:00" }, at(1, 600)),
    false,
  );
  assert.equal(
    inTimeWindow({ days: [], start: "09:00", end: "17:00" }, at(1, 600)),
    false,
  );
  assert.equal(
    inTimeWindow({ days: [1], start: "bad", end: "17:00" }, at(1, 600)),
    false,
  );
});

// ── Pure evaluation: wanted() AND-ing + network fail-safe ──────────────────────

test("wanted: no schedule ⇒ always wanted", () => {
  assert.equal(wanted(null, { now: at(6, 200) }), true);
  assert.equal(wanted({}, { now: at(6, 200) }), true);
});

test("wanted: SSID allow-list matches, mismatches, and fails safe on unknown", () => {
  const s = { network: { ssids: ["Home", "Office"] } };
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: "Home", ssidStatus: "ok" }),
    true,
  );
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: "Cafe", ssidStatus: "ok" }),
    false,
  );
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: null, ssidStatus: "ok" }),
    false,
  );
  // Unknown network → fail-safe: never force-armed.
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: "Home", ssidStatus: "unknown" }),
    false,
  );
});

test("wanted: reachability target", () => {
  const s = { network: { reach: { host: "10.0.0.1", port: 22 } } };
  assert.equal(wanted(s, { now: at(1, 600), reachable: true }), true);
  assert.equal(wanted(s, { now: at(1, 600), reachable: false }), false);
  assert.equal(wanted(s, { now: at(1, 600), reachable: null }), false);
});

test("wanted: time AND network must both hold", () => {
  const s = { time: WORK, network: { ssids: ["Home"] } };
  // In window + right SSID → wanted.
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: "Home", ssidStatus: "ok" }),
    true,
  );
  // In window but wrong SSID → not wanted.
  assert.equal(
    wanted(s, { now: at(1, 600), ssid: "Cafe", ssidStatus: "ok" }),
    false,
  );
  // Right SSID but out of window → not wanted.
  assert.equal(
    wanted(s, { now: at(6, 600), ssid: "Home", ssidStatus: "ok" }),
    false,
  );
});

// ── nextTimeBoundaryMs (local wall-clock) ─────────────────────────────────────

test("nextTimeBoundaryMs: the next window edge from a given instant", () => {
  const mon10 = new Date(2026, 0, 5, 10, 0, 0).getTime(); // Mon 2026-01-05 10:00
  assert.equal(nextTimeBoundaryMs(WORK, mon10), 7 * 3600 * 1000); // → Mon 17:00
  const mon8 = new Date(2026, 0, 5, 8, 0, 0).getTime();
  assert.equal(nextTimeBoundaryMs(WORK, mon8), 1 * 3600 * 1000); // → Mon 09:00
  // Friday evening → next edge is Monday 09:00 (skips the weekend).
  const fri18 = new Date(2026, 0, 9, 18, 0, 0).getTime(); // Fri 2026-01-09 18:00
  assert.equal(nextTimeBoundaryMs(WORK, fri18), 63 * 3600 * 1000); // 2d15h → Mon 09:00
  assert.equal(nextTimeBoundaryMs(undefined, mon10), null);
});

// ── effectiveSchedule (group inheritance) ─────────────────────────────────────

test("effectiveSchedule: own schedule wins, else the group's, else null", () => {
  const own = { time: WORK };
  const groupSched = { network: { ssids: ["Home"] } };
  assert.equal(
    effectiveSchedule({ schedule: own, group: { schedule: groupSched } }),
    own,
  );
  assert.equal(
    effectiveSchedule({ group: { schedule: groupSched } }),
    groupSched,
  );
  assert.equal(effectiveSchedule({ group: { id: "g", label: "G" } }), null);
  assert.equal(effectiveSchedule({}), null);
});

// ── Driver ────────────────────────────────────────────────────────────────────

/** Build a Scheduler over a mutable fixture, with fake engine/timers/clock. */
function harness({
  tunnels = [],
  nowMs = new Date(2026, 0, 5, 10, 0, 0).getTime(),
  readSsid,
} = {}) {
  const state = {
    tunnels,
    nowMs,
    ssid: { ssid: null, status: "unknown" },
    reach: true,
    calls: [], // ['arm'|'disarm', id]
    armed: new Set(),
    broadcasts: [],
    intervalsCreated: 0, // how many recheck intervals were ever started
  };
  const engine = {
    async arm(id) {
      state.calls.push(["arm", id]);
      state.armed.add(id);
    },
    async disarm(id) {
      state.calls.push(["disarm", id]);
      state.armed.delete(id);
    },
  };
  const scheduler = new Scheduler({
    getStores: () => ({ tunnelStore: () => ({ list: () => state.tunnels }) }),
    engine,
    now: () => state.nowMs,
    readSsid: readSsid || (async () => state.ssid),
    probeReachable: async () => state.reach,
    broadcast: (channel, payload) =>
      state.broadcasts.push({ channel, payload }),
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    setIntervalFn: () => {
      state.intervalsCreated += 1;
      return { unref() {} };
    },
    clearIntervalFn: () => {},
  });
  return { scheduler, state };
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

const tunnel = (id, schedule, over = {}) => ({
  id,
  name: id,
  enabled: true,
  schedule,
  ...over,
});

test("driver: initial assertion arms in-window tunnels, disarms out-of-window", async () => {
  const { scheduler, state } = harness({
    tunnels: [
      tunnel("in", { time: WORK }), // Mon 10:00 → wanted
      tunnel("out", { time: { days: [6], start: "09:00", end: "17:00" } }), // Sat only
    ],
  });
  scheduler.setEnabled(true);
  await settle();

  assert.deepEqual([...state.armed], ["in"]);
  assert.ok(state.calls.some((c) => c[0] === "arm" && c[1] === "in"));
});

test("driver: a window edge disarms; a re-check at the same wanted does nothing", async () => {
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { time: WORK })],
  });
  scheduler.setEnabled(true);
  await settle();
  assert.deepEqual([...state.armed], ["t"]);

  // A re-check with no boundary crossed must not churn the engine.
  const before = state.calls.length;
  await scheduler.reevaluate();
  assert.equal(state.calls.length, before);

  // Cross the window end → disarm.
  state.nowMs = new Date(2026, 0, 5, 18, 0, 0).getTime(); // Mon 18:00
  await scheduler.reevaluate();
  assert.deepEqual([...state.armed], []);
  assert.ok(state.calls.some((c) => c[0] === "disarm" && c[1] === "t"));
});

test("driver: a manual toggle between boundaries is never fought", async () => {
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { time: WORK })],
  });
  scheduler.setEnabled(true);
  await settle();
  assert.deepEqual([...state.armed], ["t"]);

  // User manually disarms; scheduler is told, and re-checks fire.
  state.armed.delete("t");
  scheduler.noteManual("t");
  const before = state.calls.length;
  await scheduler.reevaluate(); // same window → no edge
  assert.equal(
    state.calls.length,
    before,
    "scheduler re-armed a manual disarm",
  );
  assert.equal(state.armed.has("t"), false);

  const status = scheduler.status();
  assert.equal(status.tunnels.find((x) => x.id === "t").overridden, true);
});

test("driver: fail-safe — an unknown SSID never force-arms", async () => {
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { network: { ssids: ["Home"] } })],
  });
  state.ssid = { ssid: null, status: "unknown" };
  scheduler.setEnabled(true);
  await settle();
  assert.equal(state.armed.has("t"), false);

  // Once the SSID is readable and matches, it arms.
  state.ssid = { ssid: "Home", status: "ok" };
  await scheduler.reevaluate();
  assert.equal(state.armed.has("t"), true);

  // Losing the network (unknown) retracts it — an ambiguous network never exposes it.
  state.ssid = { ssid: null, status: "unknown" };
  await scheduler.reevaluate();
  assert.equal(state.armed.has("t"), false);
});

test("driver: reachability gates arm/disarm", async () => {
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { network: { reach: { host: "h", port: 22 } } })],
  });
  state.reach = false;
  scheduler.setEnabled(true);
  await settle();
  assert.equal(state.armed.has("t"), false);

  state.reach = true;
  await scheduler.reevaluate();
  assert.equal(state.armed.has("t"), true);
});

test("driver: group-inherited schedule governs a member without its own", async () => {
  const { scheduler, state } = harness({
    tunnels: [
      tunnel("m", undefined, {
        group: { id: "g", label: "Work", schedule: { time: WORK } },
      }),
    ],
  });
  scheduler.setEnabled(true);
  await settle();
  assert.equal(state.armed.has("m"), true);
  assert.deepEqual([...scheduler.governedIds()], ["m"]);
});

test("driver: disabled tunnels and unscheduled tunnels are not governed", async () => {
  const { scheduler } = harness({
    tunnels: [
      tunnel("off", { time: WORK }, { enabled: false }),
      tunnel("plain", undefined),
      tunnel("on", { time: WORK }),
    ],
  });
  scheduler.setEnabled(true);
  await settle();
  assert.deepEqual([...scheduler.governedIds()], ["on"]);
});

test("driver: setEnabled(false) stops governing and announces it", async () => {
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { time: WORK })],
  });
  scheduler.setEnabled(true);
  await settle();
  assert.deepEqual([...scheduler.governedIds()], ["t"]);

  scheduler.setEnabled(false);
  assert.deepEqual([...scheduler.governedIds()], []);
  assert.deepEqual(scheduler.status(), { enabled: false, tunnels: [] });
  const last = state.broadcasts[state.broadcasts.length - 1];
  assert.deepEqual(last, {
    channel: "porthippo:schedule",
    payload: { enabled: false, tunnels: [] },
  });
});

test("driver: disabling mid-evaluation aborts without acting or leaking a timer", async () => {
  // A network rule makes #runOnce await readSsid; hold that await open so we can
  // flip the master switch off while the evaluation is suspended.
  let releaseSsid;
  const readSsid = () =>
    new Promise((resolve) => {
      releaseSsid = () => resolve({ ssid: "Home", status: "ok" });
    });
  const { scheduler, state } = harness({
    tunnels: [tunnel("t", { network: { ssids: ["Home"] } })],
    readSsid,
  });

  scheduler.setEnabled(true); // starts a reevaluate that parks in readSsid
  await new Promise((r) => setImmediate(r)); // let it reach the await
  scheduler.setEnabled(false); // turn scheduling off mid-probe
  releaseSsid(); // the SSID resolves — #runOnce resumes and must bail out
  await settle();

  assert.deepEqual(state.calls, [], "no arm/disarm after being disabled");
  assert.equal(state.armed.size, 0);
  // The recheck interval must not be (re)started once disabled.
  assert.equal(state.intervalsCreated, 0);
});

test("driver: status reports the next transition + kind for a time rule", async () => {
  const { scheduler } = harness({
    tunnels: [tunnel("t", { time: WORK })],
    nowMs: new Date(2026, 0, 5, 10, 0, 0).getTime(), // Mon 10:00 (in window)
  });
  scheduler.setEnabled(true);
  await settle();
  const entry = scheduler.status().tunnels.find((x) => x.id === "t");
  assert.equal(entry.wanted, true);
  assert.equal(entry.nextTransitionKind, "disarm"); // in window → next edge closes it
  assert.equal(
    entry.nextTransitionAt,
    new Date(2026, 0, 5, 17, 0, 0).getTime(), // Mon 17:00
  );
});
