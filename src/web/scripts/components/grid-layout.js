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

// grid-layout.js — the pure geometry + placement logic behind the tunnel-detail
// snap-to-grid canvas (card-canvas.js). Every card occupies exactly one uniform
// cell addressed by integer {col, row}; the grid is infinite in both axes. These
// helpers are DOM-free and side-effect-free so they can be unit-tested directly:
// pixel geometry for a cell, first-free-cell placement in reading order, and the
// drag-drop resolution (free-cell snap, occupied-cell swap, and the automatic
// "return-home" of a card the swap displaced once its home cell frees up again).

/** The single uniform cell: a 150×90 card with a 16px gutter between cells. */
export const CELL = Object.freeze({ w: 150, h: 90, gap: 16 });

/** Reading-order placement wraps after this many columns (the grid stays
 *  infinite for dragging — this only shapes where auto-placed cards land). */
export const DEFAULT_COLS = 4;

/** Extra cells of scroll room kept beyond the placed cards' bounding box
 *  while a drag is live, so there is always somewhere to drag a card one cell
 *  further out. At rest the surface is sized tight (see contentSize). */
export const MARGIN_CELLS = 2;

/** Horizontal cell stride (card width + gutter). */
export function strideX() {
  return CELL.w + CELL.gap;
}

/** Vertical cell stride (card height + gutter). */
export function strideY() {
  return CELL.h + CELL.gap;
}

/** The x pixel of a column's left edge. */
export function cellLeft(col) {
  return col * strideX();
}

/** The y pixel of a row's top edge. */
export function cellTop(row) {
  return row * strideY();
}

/** The cell nearest a pixel point (a card's top-left), clamped to the grid. */
export function cellAt(x, y) {
  return {
    col: Math.max(0, Math.round(x / strideX())),
    row: Math.max(0, Math.round(y / strideY())),
  };
}

/** A stable string key for a cell (for Set/Map membership). */
export function cellKey(col, row) {
  return `${col},${row}`;
}

/** True when a {col,row} looks like a valid non-negative integer cell. */
function validCell(p) {
  return (
    p &&
    Number.isInteger(p.col) &&
    Number.isInteger(p.row) &&
    p.col >= 0 &&
    p.row >= 0
  );
}

/** The set of occupied cell keys in a positions map (optionally skipping one). */
export function occupiedSet(positions, exceptKey = null) {
  const set = new Set();
  for (const [k, p] of Object.entries(positions || {})) {
    if (k === exceptKey || !p) continue;
    set.add(cellKey(p.col, p.row));
  }
  return set;
}

/**
 * The first free cell in reading order — scan row by row, left→right, top→bottom
 * across `cols` columns, expanding rows as needed. `occupied` is a Set of cell
 * keys. Cells beyond the reading width (dragged-out cards) don't shift the flow.
 */
export function firstFreeCell(occupied, cols = DEFAULT_COLS) {
  // Within a width-`cols` grid, `occupied.size` filled reading cells guarantee a
  // gap within a bounded number of rows; the +2 is slack for out-of-flow cells.
  const maxRow = Math.ceil((occupied.size + 1) / cols) + 2;
  for (let row = 0; row <= maxRow; row++) {
    for (let col = 0; col < cols; col++) {
      if (!occupied.has(cellKey(col, row))) return { col, row };
    }
  }
  return { col: 0, row: maxRow + 1 };
}

/**
 * Resolve final positions for a set of visible card keys against a base layout:
 * keep each key's valid, non-colliding base cell; give every unplaced key the
 * first free cell in reading order. Returns the positions map plus `changed` —
 * true when a cell was (re)assigned or the base held keys/cells we dropped, so
 * the caller knows whether to persist.
 *
 * @param {string[]} keys      the visible cards, in order
 * @param {Object<string,{col:number,row:number}>} [base]
 * @returns {{positions: Object<string,{col:number,row:number}>, changed: boolean}}
 */
export function placeCards(keys, base = {}, cols = DEFAULT_COLS) {
  const positions = {};
  const occupied = new Set();

  // Pass 1 — honour valid base cells that don't collide with an earlier one.
  for (const key of keys) {
    const p = base[key];
    if (!validCell(p)) continue;
    const ck = cellKey(p.col, p.row);
    if (!occupied.has(ck)) {
      positions[key] = { col: p.col, row: p.row };
      occupied.add(ck);
    }
  }

  // Pass 2 — first-free (reading order) for anything still unplaced.
  for (const key of keys) {
    if (positions[key]) continue;
    const cell = firstFreeCell(occupied, cols);
    positions[key] = cell;
    occupied.add(cellKey(cell.col, cell.row));
  }

  const changed =
    Object.keys(base).some((k) => !keys.includes(k)) || // a key was removed
    keys.some((k) => {
      const b = base[k];
      const p = positions[k];
      return !b || b.col !== p.col || b.row !== p.row;
    });

  return { positions, changed };
}

/** Deep-copy a positions/homes map. */
function clonePositions(map) {
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    out[k] = v ? { col: v.col, row: v.row } : v;
  }
  return out;
}

/** The key occupying `cell` (other than `exceptKey`), or null. */
function keyAtCell(positions, cell, exceptKey) {
  for (const [k, p] of Object.entries(positions)) {
    if (k === exceptKey || !p) continue;
    if (p.col === cell.col && p.row === cell.row) return k;
  }
  return null;
}

/** True when some key (other than exceptKey) already claims `cell` as its home. */
function homeClaimed(homes, cell, exceptKey) {
  for (const [k, h] of Object.entries(homes)) {
    if (k === exceptKey || !h) continue;
    if (h.col === cell.col && h.row === cell.row) return true;
  }
  return false;
}

/**
 * Slide every displaced card whose home cell is now empty back home, cascading:
 * a returning card frees its old cell, which may release another displaced card.
 * Mutates `positions`/`homes` and records every moved key into `moved`.
 */
function resolveReturnHomes(positions, homes, moved) {
  let progress = true;
  while (progress) {
    progress = false;
    for (const [k, home] of Object.entries(homes)) {
      if (keyAtCell(positions, home, k)) continue; // home still occupied
      positions[k] = { col: home.col, row: home.row };
      delete homes[k];
      moved.add(k);
      progress = true;
      break; // positions/homes changed — restart the scan
    }
  }
}

/**
 * Resolve a drop of `key` onto `cell`. Pure: returns a fresh {positions, homes,
 * moved} or null when nothing changes.
 *
 *  - Free target → the card snaps there; its origin frees (may trigger returns).
 *  - Occupied target → swap: the occupant takes the dragged card's origin cell
 *    and remembers the target as its home, so if the intruder later leaves, the
 *    occupant returns home automatically. A deliberately dragged card forfeits
 *    any home of its own.
 *
 * @param {{positions:object, homes?:object}} state
 * @param {string} key
 * @param {{col:number,row:number}} cell
 */
export function applyDrop(state, key, cell) {
  const positions = clonePositions(state.positions);
  const homes = clonePositions(state.homes || {});
  const origin = positions[key];
  if (!origin) return null;

  const target = { col: Math.max(0, cell.col), row: Math.max(0, cell.row) };
  if (origin.col === target.col && origin.row === target.row) return null;

  const occupant = keyAtCell(positions, target, key);
  const moved = new Set([key]);

  positions[key] = target;
  delete homes[key]; // a deliberate placement clears the dragged card's own home

  if (occupant) {
    positions[occupant] = { col: origin.col, row: origin.row };
    moved.add(occupant);
    // The evicted occupant remembers where it belongs — unless it already has a
    // home (keep the original through a chain) or the target is already claimed.
    if (!homes[occupant] && !homeClaimed(homes, target, occupant)) {
      homes[occupant] = { col: target.col, row: target.row };
    }
  }

  resolveReturnHomes(positions, homes, moved);
  return { positions, homes, moved };
}

/**
 * The resting content size (px) for a positions map: exactly the placed cards'
 * bounding box — no wider or taller than the bottom-right card's bottom-right
 * edge. Zero when nothing is placed. The drag margin only exists while a drag
 * is live (see dragSize).
 */
export function contentSize(positions) {
  let maxCol = -1;
  let maxRow = -1;
  for (const p of Object.values(positions || {})) {
    if (!p) continue;
    if (p.col > maxCol) maxCol = p.col;
    if (p.row > maxRow) maxRow = p.row;
  }
  if (maxCol < 0) return { width: 0, height: 0 };
  return {
    width: cellLeft(maxCol) + CELL.w,
    height: cellTop(maxRow) + CELL.h,
  };
}

/**
 * The scrollable surface size (px) while a card is being dragged: the placed
 * cards' bounding box, at least DEFAULT_COLS wide, plus MARGIN_CELLS of drag
 * room in both axes so a card can always be dropped one cell further out.
 */
export function dragSize(positions, cols = DEFAULT_COLS) {
  let maxCol = cols - 1;
  let maxRow = 0;
  for (const p of Object.values(positions || {})) {
    if (!p) continue;
    if (p.col > maxCol) maxCol = p.col;
    if (p.row > maxRow) maxRow = p.row;
  }
  return {
    width: (maxCol + 1 + MARGIN_CELLS) * strideX(),
    height: (maxRow + 1 + MARGIN_CELLS) * strideY(),
  };
}

/** The min/max cell extent of a positions map, or null when it's empty. */
export function boundingBox(positions) {
  let minCol = Infinity;
  let minRow = Infinity;
  let maxCol = -Infinity;
  let maxRow = -Infinity;
  for (const p of Object.values(positions || {})) {
    if (!p) continue;
    minCol = Math.min(minCol, p.col);
    minRow = Math.min(minRow, p.row);
    maxCol = Math.max(maxCol, p.col);
    maxRow = Math.max(maxRow, p.row);
  }
  if (!Number.isFinite(minCol)) return null;
  return { minCol, minRow, maxCol, maxRow };
}
