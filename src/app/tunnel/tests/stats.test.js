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
