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
 * stats.test.js — unit tests for the per-tunnel `Stats` object. All time comes
 * from an injected fake clock, so the rolling-rate math is exercised without real
 * timers: a burst produces a non-zero rate that decays to zero within one window,
 * totals stay monotonic, and connection counting / lifecycle timestamps track.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { Stats } = require("../stats");

// A controllable clock: `now()` reads the current fake time; `advance(ms)` moves it.
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("totals are monotonic and never decrease as bytes accrue", () => {
  const clock = fakeClock();
  const stats = new Stats({ now: clock.now });
  stats.onArmed();

  let prevUp = 0;
  let prevDown = 0;
  let prevTotal = 0;
  for (let i = 0; i < 5; i++) {
    stats.addUp(100);
    stats.addDown(250);
    clock.advance(200);
    const s = stats.snapshot();
    assert.ok(s.bytesUp >= prevUp, "bytesUp is monotonic");
    assert.ok(s.bytesDown >= prevDown, "bytesDown is monotonic");
    assert.ok(s.totalBytes >= prevTotal, "totalBytes is monotonic");
    assert.equal(s.totalBytes, s.bytesUp + s.bytesDown);
    prevUp = s.bytesUp;
    prevDown = s.bytesDown;
    prevTotal = s.totalBytes;
  }

  const final = stats.snapshot();
  assert.equal(final.bytesUp, 500);
  assert.equal(final.bytesDown, 1250);
  assert.equal(final.totalBytes, 1750);
});

test("rate rises under a burst and decays to zero once traffic stops", () => {
  const clock = fakeClock();
  const stats = new Stats({ now: clock.now });
  stats.onArmed();
  stats.onConnected();

  // A burst in both directions right now.
  stats.addUp(9000);
  stats.addDown(30000);

  const hot = stats.snapshot();
  assert.ok(hot.rateUp > 0, "up rate is non-zero right after a burst");
  assert.ok(hot.rateDown > 0, "down rate is non-zero right after a burst");
  assert.ok(
    hot.rateDown > hot.rateUp,
    "the heavier direction reads a higher rate",
  );

  // Idle past the whole rolling window: rates fall to zero, totals are untouched.
  clock.advance(3500);
  const cold = stats.snapshot();
  assert.equal(cold.rateUp, 0, "up rate decays to zero when idle");
  assert.equal(cold.rateDown, 0, "down rate decays to zero when idle");
  assert.equal(cold.bytesUp, 9000, "totals do not decay with the rate");
  assert.equal(cold.bytesDown, 30000);
  assert.equal(cold.totalBytes, 39000);
});

test("connection counting tracks opens and closes and never goes negative", () => {
  const stats = new Stats({ now: fakeClock().now });
  stats.onArmed();
  assert.equal(stats.snapshot().activeConnections, 0);

  stats.connOpened();
  stats.connOpened();
  stats.connOpened();
  assert.equal(stats.snapshot().activeConnections, 3);

  stats.connClosed();
  assert.equal(stats.snapshot().activeConnections, 2);

  // Over-closing is clamped at zero rather than going negative.
  stats.connClosed();
  stats.connClosed();
  stats.connClosed();
  assert.equal(stats.snapshot().activeConnections, 0);
});

test("connectionCount is cumulative and errorCount tracks onError()", () => {
  const stats = new Stats({ now: fakeClock().now });
  stats.onArmed();
  assert.equal(stats.snapshot().connectionCount, 0);
  assert.equal(stats.snapshot().errorCount, 0);

  // Cumulative: closes never decrement it, unlike activeConnections.
  stats.connOpened();
  stats.connOpened();
  stats.connClosed();
  const s = stats.snapshot();
  assert.equal(s.activeConnections, 1, "one still live");
  assert.equal(s.connectionCount, 2, "two were opened in total");

  stats.onError();
  stats.onError();
  assert.equal(stats.snapshot().errorCount, 2);
});

test("onError logs a timestamped event; the log resets with the count on re-arm", () => {
  const clock = fakeClock(5_000_000);
  const stats = new Stats({ now: clock.now });
  stats.onArmed();
  assert.deepEqual(stats.events(), []);

  stats.onError("bind: address in use");
  clock.advance(1000);
  stats.onError("forward failed: ECONNREFUSED");

  const log = stats.events();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], {
    at: 5_000_000,
    level: "error",
    message: "bind: address in use",
  });
  assert.equal(log[1].at, 5_001_000);
  assert.equal(log[1].message, "forward failed: ECONNREFUSED");
  // Count and log stay in lockstep.
  assert.equal(stats.snapshot().errorCount, 2);

  // events() returns a copy — mutating it can't corrupt the internal log.
  log.pop();
  assert.equal(stats.events().length, 2);

  stats.onArmed();
  assert.deepEqual(stats.events(), []);
  assert.equal(stats.snapshot().errorCount, 0);
});

test("the event log is bounded to the most recent entries", () => {
  const stats = new Stats({ now: fakeClock().now });
  stats.onArmed();
  for (let i = 0; i < 150; i++) stats.onError(`err ${i}`);
  const log = stats.events();
  assert.equal(log.length, 100, "bounded to MAX_EVENTS");
  assert.equal(log[0].message, "err 50", "oldest fell off");
  assert.equal(log.at(-1).message, "err 149", "newest kept");
});

test("firstConnectedAt is stamped once; lastDisconnectedAt tracks teardown", () => {
  const clock = fakeClock(9_000_000);
  const stats = new Stats({ now: clock.now });
  stats.onArmed();
  assert.equal(stats.snapshot().firstConnectedAt, null);
  assert.equal(stats.snapshot().lastDisconnectedAt, null);

  clock.advance(1000);
  stats.onConnected();
  assert.equal(stats.snapshot().firstConnectedAt, 9_001_000);
  assert.equal(stats.snapshot().openedAt, 9_001_000);

  clock.advance(500);
  stats.onDisconnected();
  assert.equal(stats.snapshot().lastDisconnectedAt, 9_001_500);
  assert.equal(stats.snapshot().openedAt, null);

  // A later reconnect keeps firstConnectedAt (the FIRST), moves openedAt.
  clock.advance(2000);
  stats.onConnected();
  const s = stats.snapshot();
  assert.equal(s.firstConnectedAt, 9_001_000, "first connect is sticky");
  assert.equal(s.openedAt, 9_003_500, "openedAt is the current session");
});

test("re-arming zeroes the new cumulative counters and session timestamps", () => {
  const clock = fakeClock();
  const stats = new Stats({ now: clock.now });
  stats.onArmed();
  stats.connOpened();
  stats.onError();
  stats.onConnected();
  stats.onDisconnected();

  clock.advance(5000);
  stats.onArmed(); // fresh session
  const s = stats.snapshot();
  assert.equal(s.connectionCount, 0);
  assert.equal(s.errorCount, 0);
  assert.equal(s.firstConnectedAt, null);
  assert.equal(s.lastDisconnectedAt, null);
});

test("lifecycle stamps armedAt / openedAt / lastActiveAt correctly", () => {
  const clock = fakeClock(5_000_000);
  const stats = new Stats({ now: clock.now });

  // Before arming, nothing is stamped.
  let s = stats.snapshot();
  assert.equal(s.armedAt, null);
  assert.equal(s.openedAt, null);
  assert.equal(s.lastActiveAt, null);

  stats.onArmed();
  assert.equal(stats.snapshot().armedAt, 5_000_000);
  assert.equal(stats.snapshot().openedAt, null, "not connected yet");

  clock.advance(1000);
  stats.onConnected();
  assert.equal(stats.snapshot().openedAt, 5_001_000);

  clock.advance(500);
  stats.addDown(42);
  assert.equal(stats.snapshot().lastActiveAt, 5_001_500);

  // The SSH session ends: openedAt clears but armedAt (the listener) persists.
  stats.onDisconnected();
  s = stats.snapshot();
  assert.equal(s.openedAt, null, "openedAt resets when the session ends");
  assert.equal(s.armedAt, 5_000_000, "armedAt survives an idle teardown");
});

test("a fresh onArmed() zeroes the previous session's totals and rate", () => {
  const clock = fakeClock();
  const stats = new Stats({ now: clock.now });
  stats.onArmed();
  stats.addUp(1234);
  stats.addDown(5678);
  assert.equal(stats.snapshot().totalBytes, 6912);

  clock.advance(10_000);
  stats.onArmed(); // re-arm: a brand new measurement session
  const s = stats.snapshot();
  assert.equal(s.bytesUp, 0);
  assert.equal(s.bytesDown, 0);
  assert.equal(s.totalBytes, 0);
  assert.equal(s.rateUp, 0);
  assert.equal(s.rateDown, 0);
  assert.equal(s.armedAt, clock.now());
});
