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

import { t } from "../i18n.js";
import {
  CARDS,
  CATEGORIES,
  DEFAULT_CARD_ORDER,
  getCard,
  visibleCards,
  hiddenCards,
  reorderCards,
  cardLabel,
  cardsByCategory,
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

// ── Category grouping (the selector menu) ────────────────────────────────────

test("every card declares a known category", () => {
  for (const c of CARDS) {
    assert.ok(c.category, `${c.key} has no category`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(CATEGORIES, c.category),
      `${c.key} has unknown category ${c.category}`,
    );
  }
});

test("cardsByCategory partitions every card, groups and cards alphabetical", () => {
  const alpha = (arr) => [...arr].sort((a, b) => a.localeCompare(b));
  const groups = cardsByCategory();

  // Category headings are alphabetical by their (localised) label.
  const labels = groups.map((g) => t(g.labelKey));
  assert.deepEqual(labels, alpha(labels), "categories not alphabetical");

  // Every catalogue card appears exactly once across the groups (a partition).
  const flat = groups.flatMap((g) => g.keys);
  assert.equal(flat.length, DEFAULT_CARD_ORDER.length, "no card dropped/dup'd");
  assert.deepEqual(alpha(flat), alpha(DEFAULT_CARD_ORDER));

  // Within each group the cards are alphabetical by their label.
  for (const g of groups) {
    const gLabels = g.keys.map(cardLabel);
    assert.deepEqual(gLabels, alpha(gLabels), `${g.category} not alphabetical`);
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

test("peak and combined-throughput cards sort by their snapshot fields", () => {
  const ctx = (snap) => ({ snap, now: NOW, state: "connected" });
  assert.equal(
    card("peakDownload").sortValue(ctx({ peakRateDown: 2048 })),
    2048,
  );
  assert.equal(card("peakUpload").sortValue(ctx({ peakRateUp: 512 })), 512);
  assert.equal(
    card("peakConnections").sortValue(ctx({ peakConnections: 7 })),
    7,
  );
  assert.equal(
    card("combinedThroughput").sortValue(ctx({ rateUp: 100, rateDown: 400 })),
    500,
  );
  assert.equal(
    card("combinedThroughput").value(ctx({ rateUp: 100, rateDown: 400 })),
    "500 B/s",
  );
});

test("avgThroughput is total bytes over the armed lifetime", () => {
  // 6000 bytes across 3s armed → 2000 B/s.
  const armed = {
    snap: { totalBytes: 6000, armedAt: NOW - 3000 },
    now: NOW,
    state: "connected",
  };
  assert.equal(card("avgThroughput").sortValue(armed), 2000);
  assert.equal(card("avgThroughput").value(armed), "2.0 KB/s");

  // Not armed, or no time elapsed → zero (no divide-by-zero, no first-tick spike).
  const notArmed = { snap: { totalBytes: 6000 }, now: NOW, state: "disarmed" };
  assert.equal(card("avgThroughput").sortValue(notArmed), 0);
  const zeroElapsed = {
    snap: { totalBytes: 6000, armedAt: NOW },
    now: NOW,
    state: "connected",
  };
  assert.equal(card("avgThroughput").sortValue(zeroElapsed), 0);
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

test("Last connection reads lastConnectedAt and survives a disconnect", () => {
  const value = (snap, state) =>
    card("lastConnection").value({ snap, now: NOW, state });

  // Connected: the current session's connect time.
  assert.equal(
    value({ openedAt: NOW - 5000, lastConnectedAt: NOW - 5000 }, "connected"),
    "5s ago",
  );
  // Disconnected: openedAt is cleared, but lastConnectedAt persists — so it keeps
  // reporting the real time rather than reverting to "never".
  assert.equal(
    value({ openedAt: null, lastConnectedAt: NOW - 5000 }, "listening"),
    "5s ago",
  );
  // Never connected this arm: "never".
  assert.equal(
    value({ openedAt: null, lastConnectedAt: null }, "listening"),
    "never",
  );
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

// ── Reconnect card (Feature 130) ─────────────────────────────────────────────

test("reconnect card: dash + no tone when the tunnel isn't reconnecting", () => {
  const ctx = { snap: { rateUp: 0 }, now: NOW, state: "connected" };
  assert.equal(card("reconnect").value(ctx), t("card.none"));
  assert.deepEqual(cardToneClasses(card("reconnect"), ctx), []);
  assert.equal(card("reconnect").sortValue(ctx), 0);
});

test("reconnect card: attempt + rounded-up countdown, warn-toned, while retrying", () => {
  const ctx = {
    snap: { attempt: 2, nextRetryAt: NOW + 2400 },
    now: NOW,
    state: "connecting",
  };
  const value = card("reconnect").value(ctx);
  assert.match(value, /attempt 2/);
  assert.match(value, /3s/); // ceil(2400 / 1000) = 3
  assert.deepEqual(cardToneClasses(card("reconnect"), ctx), [
    "card-value--warn",
  ]);
  assert.equal(card("reconnect").sortValue(ctx), 1);
});

test("reconnect card: a past-due countdown floors at zero", () => {
  const ctx = { snap: { attempt: 5, nextRetryAt: NOW - 8000 }, now: NOW };
  assert.match(card("reconnect").value(ctx), /0s/);
});

test("reconnect card: a bare attempt (no countdown) still reads as reconnecting", () => {
  const ctx = { snap: { attempt: 3 }, now: NOW, state: "connecting" };
  assert.match(card("reconnect").value(ctx), /attempt 3/);
  assert.equal(card("reconnect").sortValue(ctx), 1);
});
