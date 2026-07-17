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

// grid-layout.test.js — the pure snap-grid logic: cell geometry, reading-order
// first-free placement, layout normalization, and the drag-drop resolution
// (free-cell snap, occupied-cell swap, and the automatic return-home cascade).

import test from "node:test";
import assert from "node:assert/strict";

import {
  CELL,
  DEFAULT_COLS,
  cellLeft,
  cellTop,
  cellAt,
  firstFreeCell,
  occupiedSet,
  placeCards,
  applyDrop,
  contentSize,
  dragSize,
  boundingBox,
} from "../components/grid-layout.js";

const strideX = CELL.w + CELL.gap;
const strideY = CELL.h + CELL.gap;

// ── Geometry ──────────────────────────────────────────────────────────────────

test("cell geometry maps col/row to pixels and back to the nearest cell", () => {
  assert.equal(cellLeft(0), 0);
  assert.equal(cellLeft(2), 2 * strideX);
  assert.equal(cellTop(3), 3 * strideY);
  // Nearest-cell rounds and clamps to the non-negative grid.
  assert.deepEqual(cellAt(0, 0), { col: 0, row: 0 });
  assert.deepEqual(cellAt(2 * strideX + 4, strideY - 4), { col: 2, row: 1 });
  assert.deepEqual(cellAt(-50, -50), { col: 0, row: 0 });
});

// ── First-free (reading order) ────────────────────────────────────────────────

test("firstFreeCell scans reading order, wrapping after DEFAULT_COLS", () => {
  assert.deepEqual(firstFreeCell(new Set()), { col: 0, row: 0 });
  // Fill row 0 completely → first free is (0,1).
  const full = new Set(["0,0", "1,0", "2,0", "3,0"]);
  assert.deepEqual(firstFreeCell(full), { col: 0, row: 1 });
  // A gap in the middle is taken before any later cell.
  const gap = new Set(["0,0", "2,0", "3,0"]);
  assert.deepEqual(firstFreeCell(gap), { col: 1, row: 0 });
});

test("out-of-flow cells (dragged far out) don't shift reading placement", () => {
  // A card parked at col 9 doesn't consume a reading-grid cell.
  const occupied = new Set(["9,0"]);
  assert.deepEqual(firstFreeCell(occupied), { col: 0, row: 0 });
});

test("occupiedSet skips a named key", () => {
  const positions = { a: { col: 0, row: 0 }, b: { col: 1, row: 0 } };
  assert.deepEqual([...occupiedSet(positions)].sort(), ["0,0", "1,0"]);
  assert.deepEqual([...occupiedSet(positions, "a")], ["1,0"]);
});

// ── placeCards ────────────────────────────────────────────────────────────────

test("placeCards lays a fresh set out in reading order", () => {
  const { positions, changed } = placeCards(["a", "b", "c", "d", "e"], {});
  assert.deepEqual(positions.a, { col: 0, row: 0 });
  assert.deepEqual(positions.d, { col: 3, row: 0 });
  assert.deepEqual(positions.e, { col: 0, row: 1 }); // wrapped
  assert.equal(changed, true);
});

test("placeCards keeps stored cells and only assigns the newcomer", () => {
  const base = { a: { col: 0, row: 0 }, b: { col: 2, row: 1 } };
  const { positions, changed } = placeCards(["a", "b", "c"], base);
  assert.deepEqual(positions.a, { col: 0, row: 0 }, "kept");
  assert.deepEqual(positions.b, { col: 2, row: 1 }, "kept");
  // 'c' gets the first free reading cell (0,0 taken → 1,0).
  assert.deepEqual(positions.c, { col: 1, row: 0 });
  assert.equal(changed, true);
});

test("placeCards is unchanged when every key already has its cell", () => {
  const base = { a: { col: 0, row: 0 }, b: { col: 1, row: 0 } };
  const { changed } = placeCards(["a", "b"], base);
  assert.equal(changed, false);
});

test("placeCards drops a removed key's cell (frees the gap, no re-pack)", () => {
  const base = {
    a: { col: 0, row: 0 },
    b: { col: 1, row: 0 },
    c: { col: 2, row: 0 },
  };
  const { positions, changed } = placeCards(["a", "c"], base); // drop b
  assert.deepEqual(positions.a, { col: 0, row: 0 });
  assert.deepEqual(positions.c, { col: 2, row: 0 }, "c stays put — no re-pack");
  assert.equal(positions.b, undefined);
  assert.equal(changed, true);
});

test("placeCards reassigns a colliding base cell instead of stacking", () => {
  const base = { a: { col: 1, row: 0 }, b: { col: 1, row: 0 } };
  const { positions } = placeCards(["a", "b"], base);
  assert.deepEqual(positions.a, { col: 1, row: 0 });
  assert.notDeepEqual(positions.b, { col: 1, row: 0 }, "b was moved off a");
});

// ── applyDrop: snap, swap, return-home ────────────────────────────────────────

const layout3 = () => ({
  a: { col: 0, row: 0 },
  b: { col: 1, row: 0 },
  c: { col: 2, row: 0 },
});

test("applyDrop onto a free cell just moves the card", () => {
  const r = applyDrop({ positions: layout3(), homes: {} }, "a", {
    col: 3,
    row: 0,
  });
  assert.deepEqual(r.positions.a, { col: 3, row: 0 });
  assert.deepEqual(r.positions.b, { col: 1, row: 0 }, "others untouched");
  assert.deepEqual([...r.moved], ["a"]);
});

test("applyDrop onto an occupied cell swaps and records the occupant's home", () => {
  const r = applyDrop({ positions: layout3(), homes: {} }, "a", {
    col: 2,
    row: 0,
  });
  assert.deepEqual(r.positions.a, { col: 2, row: 0 });
  assert.deepEqual(r.positions.c, { col: 0, row: 0 }, "c took a's origin");
  assert.deepEqual(r.homes.c, { col: 2, row: 0 }, "c remembers its home");
});

test("a dropped-in-place or no-op drag returns null", () => {
  assert.equal(
    applyDrop({ positions: layout3(), homes: {} }, "a", { col: 0, row: 0 }),
    null,
  );
});

test("a displaced card returns home once its home cell frees up", () => {
  // a swaps onto c → c displaced to (0,0), home (2,0).
  const s1 = applyDrop({ positions: layout3(), homes: {} }, "a", {
    col: 2,
    row: 0,
  });
  // Now move a away to a free cell (3,0) → (2,0) empties → c returns home.
  const s2 = applyDrop({ positions: s1.positions, homes: s1.homes }, "a", {
    col: 3,
    row: 0,
  });
  assert.deepEqual(s2.positions.c, { col: 2, row: 0 }, "c is home again");
  assert.deepEqual(s2.positions.a, { col: 3, row: 0 });
  assert.equal(s2.homes.c, undefined, "home reference cleared on return");
  assert.ok(s2.moved.has("c"), "c was animated");
});

test("return-home is reversible — swap back and forth converges", () => {
  let state = { positions: layout3(), homes: {} };
  // a → c (swap), then a back to origin (0,0): c must be home, nothing orphaned.
  state = applyDrop(state, "a", { col: 2, row: 0 });
  state = applyDrop(state, "a", { col: 0, row: 0 });
  assert.deepEqual(state.positions.a, { col: 0, row: 0 });
  assert.deepEqual(state.positions.c, { col: 2, row: 0 });
  assert.deepEqual(state.homes, {}, "no lingering displacement");
});

test("dragging a card deliberately forfeits its own home", () => {
  const s1 = applyDrop({ positions: layout3(), homes: {} }, "a", {
    col: 2,
    row: 0,
  }); // c displaced (home 2,0)
  // The user deliberately drags the displaced c elsewhere — its home is dropped.
  const s2 = applyDrop({ positions: s1.positions, homes: s1.homes }, "c", {
    col: 3,
    row: 3,
  });
  assert.equal(s2.homes.c, undefined, "c's home cleared by a deliberate move");
  assert.deepEqual(s2.positions.c, { col: 3, row: 3 });
});

// ── Sizing ────────────────────────────────────────────────────────────────────

test("contentSize is tight: exactly the bottom-right card's bottom-right edge", () => {
  assert.deepEqual(contentSize({}), { width: 0, height: 0 });
  const one = contentSize({ a: { col: 0, row: 0 } });
  assert.equal(one.width, CELL.w);
  assert.equal(one.height, CELL.h);
  const wide = contentSize({ a: { col: 9, row: 4 }, b: { col: 0, row: 0 } });
  assert.equal(wide.width, 9 * strideX + CELL.w);
  assert.equal(wide.height, 4 * strideY + CELL.h);
});

test("dragSize is at least the default width plus margin and grows with the cards", () => {
  const min = dragSize({ a: { col: 0, row: 0 } });
  assert.equal(min.width, (DEFAULT_COLS + 2) * strideX); // +MARGIN_CELLS(2)
  const wide = dragSize({ a: { col: 9, row: 4 } });
  assert.equal(wide.width, (9 + 1 + 2) * strideX);
  assert.equal(wide.height, (4 + 1 + 2) * strideY);
});

test("boundingBox spans the placed cells (null when empty)", () => {
  assert.equal(boundingBox({}), null);
  assert.deepEqual(
    boundingBox({ a: { col: 1, row: 2 }, b: { col: 4, row: 0 } }),
    { minCol: 1, minRow: 0, maxCol: 4, maxRow: 2 },
  );
});
