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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  formatRate,
  formatDuration,
  formatRelativeTime,
} from "../utils/format.js";

test("formatBytes: sub-kilobyte values are whole bytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1023), "1023 B");
});

test("formatBytes: scales through KB/MB/GB with one decimal", () => {
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(6 * 1024 * 1024), "6.0 MB");
  assert.equal(formatBytes(2.3 * 1024 * 1024 * 1024), "2.3 GB");
});

test("formatBytes: bad input clamps to 0 B", () => {
  assert.equal(formatBytes(NaN), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(undefined), "0 B");
});

test("formatRate: appends /s to the byte size", () => {
  assert.equal(formatRate(0), "0 B/s");
  assert.equal(formatRate(12800), "12.5 KB/s");
});

test("formatDuration: two largest non-zero units", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(252_000), "4m 12s");
  assert.equal(formatDuration(3_780_000), "1h 3m");
  assert.equal(formatDuration((2 * 24 + 4) * 3_600_000), "2d 4h");
});

test("formatDuration: bad input is 0s", () => {
  assert.equal(formatDuration(NaN), "0s");
  assert.equal(formatDuration(-1000), "0s");
});

test("formatRelativeTime: coarse buckets against an injected now", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(now, now), "just now");
  assert.equal(formatRelativeTime(now - 2_000, now), "2s ago");
  assert.equal(formatRelativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(formatRelativeTime(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(formatRelativeTime(now - 4 * 86_400_000, now), "4d ago");
});

test("formatRelativeTime: null is 'never', future is 'just now'", () => {
  const now = 1_000_000_000_000;
  assert.equal(formatRelativeTime(null, now), "never");
  assert.equal(formatRelativeTime(undefined, now), "never");
  assert.equal(formatRelativeTime(now + 5_000, now), "just now");
});
