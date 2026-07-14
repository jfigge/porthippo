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

// card-catalog.test.js — the shared metric catalogue used by both the detail
// cards and the list columns: the visible-set + reorder helpers (moved here from
// tunnel-detail), each card's numeric/state `sortValue` used to sort a column,
// and the tone-class helper both views share.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CARDS,
  DEFAULT_CARD_ORDER,
  getCard,
  visibleCards,
  hiddenCards,
  reorderCards,
  cardLabel,
  cardToneClasses,
} from "../components/card-catalog.js";

const NOW = 1_000_000;
const card = (key) => getCard(key);

test("getCard resolves a key, or undefined", () => {
  assert.equal(getCard("download").key, "download");
  assert.equal(getCard("nope"), undefined);
});

test("every card exposes value() and sortValue()", () => {
  for (const c of CARDS) {
    assert.equal(typeof c.value, "function", `${c.key} value()`);
    assert.equal(typeof c.sortValue, "function", `${c.key} sortValue()`);
  }
});

// ── Pure visible-set helpers (shared by both views) ──────────────────────────

test("visibleCards treats a saved array as the visible set", () => {
  assert.deepEqual(visibleCards(["errors", "download"]), [
    "errors",
    "download",
  ]);
  assert.deepEqual(visibleCards(["download", "bogus", "download"]), [
    "download",
  ]);
  assert.deepEqual(visibleCards(undefined), [...DEFAULT_CARD_ORDER]);
  assert.deepEqual(visibleCards([]), []);
});

test("hiddenCards is the default-order complement of the visible set", () => {
  const hidden = hiddenCards(["download", "upload"]);
  assert.ok(!hidden.includes("download"));
  assert.ok(hidden.includes("errors"));
  assert.equal(hidden.length, DEFAULT_CARD_ORDER.length - 2);
});

test("reorderCards moves a key to the target slot", () => {
  assert.deepEqual(reorderCards(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(reorderCards(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
  assert.deepEqual(reorderCards(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
});

test("cardLabel resolves a known key and falls back to the raw key", () => {
  assert.equal(cardLabel("download"), "Download");
  assert.equal(cardLabel("mystery"), "mystery");
});

// ── sortValue: numeric fields, durations, and the State rank ─────────────────

test("numeric cards sort by their snapshot field", () => {
  const ctx = (snap) => ({ snap, now: NOW, state: "connected" });
  assert.equal(card("download").sortValue(ctx({ rateDown: 1500 })), 1500);
  assert.equal(card("connections").sortValue(ctx({ activeConnections: 4 })), 4);
  assert.equal(card("transferred").sortValue(ctx({ totalBytes: 2048 })), 2048);
  assert.equal(card("errors").sortValue(ctx({ errorCount: 3 })), 3);
});

test("a missing snapshot sorts numerics as 0 and durations as -1", () => {
  const ctx = { snap: null, now: NOW, state: "disarmed" };
  assert.equal(card("download").sortValue(ctx), 0);
  assert.equal(card("openFor").sortValue(ctx), -1);
  assert.equal(card("idle").sortValue(ctx), -1);
});

test("duration cards sort by elapsed time", () => {
  const ctx = { snap: { openedAt: NOW - 5000 }, now: NOW, state: "connected" };
  assert.equal(card("openFor").sortValue(ctx), 5000);
});

test("the State card sorts by a quiet→busy rank", () => {
  const rank = (state) => card("state").sortValue({ state, now: NOW });
  assert.ok(rank("connected") > rank("paused"));
  assert.ok(rank("paused") > rank("disarmed"));
  assert.equal(rank("bogus"), -1);
});

// ── Tone classes (shared colouring) ──────────────────────────────────────────

test("cardToneClasses reflects static, computed, and state tones", () => {
  const ctx = (snap, state) => ({ snap, now: NOW, state });
  assert.deepEqual(cardToneClasses(card("download"), ctx({}, "connected")), [
    "card-value--down",
  ]);
  // errors: red only when non-zero.
  assert.deepEqual(
    cardToneClasses(card("errors"), ctx({ errorCount: 2 }, "connected")),
    ["card-value--error"],
  );
  assert.deepEqual(
    cardToneClasses(card("errors"), ctx({ errorCount: 0 }, "connected")),
    [],
  );
  // state: coloured by the live state.
  assert.deepEqual(cardToneClasses(card("state"), ctx({}, "paused")), [
    "card-value--state-paused",
  ]);
});
