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

// card-canvas.test.js — the snap-to-grid canvas component in isolation: the DOM
// contract the CSS relies on (a sized surface, the dashed grid overlay + target
// ghosts), first-free placement when a card is added, the grid reveal on lift,
// and the "no change" settle when a card is dropped back where it started.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { CardCanvas } from "../components/card-canvas.js";
import { el } from "../dom.js";
import { CELL, cellLeft, cellTop } from "../components/grid-layout.js";

const strideX = CELL.w + CELL.gap;

function mount() {
  resetDom();
  const layouts = [];
  const hover = [];
  const deleted = [];
  const canvas = new CardCanvas({
    onLayoutChange: (p) => layouts.push(p),
    onDeleteHover: (a) => hover.push(a),
    onDelete: (k) => deleted.push(k),
  });
  document.body.appendChild(canvas.element);
  return { canvas, layouts, hover, deleted };
}

const node = (key) =>
  el("div", { class: "detail-card", dataset: { card: key } });
const entries = (...keys) => keys.map((key) => ({ key, node: node(key) }));
const cardEl = (canvas, key) =>
  canvas.element.querySelector(`.detail-card[data-card="${key}"]`);
const transform = (canvas, key) => cardEl(canvas, key).style.transform;

/** Register a delete zone with a fixed client rect (jsdom lays nothing out). */
function deleteZone(
  canvas,
  rect = { left: 500, top: 0, right: 620, bottom: 40 },
) {
  const zone = el("div");
  document.body.appendChild(zone);
  zone.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
  });
  canvas.setDeleteZone(zone);
  return zone;
}

const down = (target, x, y) =>
  target.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      clientX: x,
      clientY: y,
      button: 0,
      bubbles: true,
    }),
  );
const move = (target, x, y) =>
  target.dispatchEvent(
    new window.MouseEvent("pointermove", { clientX: x, clientY: y }),
  );
const up = (target, x, y) =>
  target.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: x, clientY: y }),
  );

test("the canvas exposes the surface, overlay, and two target ghosts", () => {
  const { canvas } = mount();
  const surface = canvas.element.querySelector(".detail-cards-surface");
  assert.ok(surface, "sized surface plane present");
  assert.ok(
    surface.querySelector(".card-grid-overlay"),
    "grid overlay present",
  );
  assert.ok(
    surface.querySelector(".card-grid-ghost--snap"),
    "snap ghost present",
  );
  assert.ok(
    surface.querySelector(".card-grid-ghost--vacated"),
    "vacated ghost present",
  );
});

test("setCards sizes the surface tight and places cards at their cells", () => {
  const { canvas } = mount();
  canvas.setCards("t1", entries("a", "b", "c"), null);
  const surface = canvas.element.querySelector(".detail-cards-surface");
  // At rest the surface ends at the bottom-right card's bottom-right edge —
  // three cards in a row: cols 0..2 wide, one row tall. No drag margin.
  assert.equal(surface.style.width, `${cellLeft(2) + CELL.w}px`);
  assert.equal(surface.style.height, `${CELL.h}px`);
  assert.match(transform(canvas, "a"), /translate\(0px,\s*0px\)/);
  assert.equal(transform(canvas, "b"), `translate(${cellLeft(1)}px, 0px)`);
});

test("a newly added card takes the first free cell; the rest keep their cells", () => {
  const { canvas, layouts } = mount();
  canvas.setCards("t1", entries("a", "b"), {
    a: { col: 0, row: 0 },
    b: { col: 1, row: 0 },
  });
  layouts.length = 0;
  // Re-render the same tunnel with a third card → 'c' lands at the first gap (2,0).
  canvas.setCards("t1", entries("a", "b", "c"), null);
  assert.equal(transform(canvas, "c"), `translate(${cellLeft(2)}px, 0px)`);
  assert.ok(layouts.length >= 1, "the assignment was reported for persistence");
  assert.deepEqual(layouts.at(-1).c, { col: 2, row: 0 });
});

test("lifting a card reveals the grid overlay; dropping hides it again", () => {
  const { canvas } = mount();
  canvas.setCards("t1", entries("a", "b"), null);
  const overlay = canvas.element.querySelector(".card-grid-overlay");
  const surface = canvas.element.querySelector(".detail-cards-surface");
  const a = cardEl(canvas, "a");
  assert.equal(overlay.hidden, true, "overlay hidden at rest");
  const restWidth = surface.style.width;

  a.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      clientX: 0,
      clientY: 0,
      button: 0,
      bubbles: true,
    }),
  );
  a.dispatchEvent(
    new window.MouseEvent("pointermove", { clientX: 40, clientY: 0 }),
  );
  assert.equal(overlay.hidden, false, "overlay revealed while dragging");
  assert.ok(a.classList.contains("detail-card--dragging"));
  // The surface expands with drag room only while the grid is showing:
  // DEFAULT_COLS(4) + MARGIN_CELLS(2) wide.
  assert.equal(surface.style.width, `${6 * strideX}px`);

  a.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: 40, clientY: 0 }),
  );
  assert.equal(overlay.hidden, true, "overlay hidden after drop");
  assert.ok(!a.classList.contains("detail-card--dragging"));
  assert.equal(surface.style.width, restWidth, "surface shrinks back tight");
});

test("a below-threshold press is treated as a click, not a drag", () => {
  const { canvas, layouts } = mount();
  canvas.setCards("t1", entries("a", "b"), null);
  layouts.length = 0;
  const a = cardEl(canvas, "a");
  a.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      clientX: 0,
      clientY: 0,
      button: 0,
      bubbles: true,
    }),
  );
  a.dispatchEvent(
    new window.MouseEvent("pointermove", { clientX: 2, clientY: 0 }),
  ); // < 4px
  a.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: 2, clientY: 0 }),
  );
  assert.ok(!a.classList.contains("detail-card--dragging"), "never lifted");
  assert.equal(layouts.length, 0, "no layout change from a tap");
});

test("hovering the delete zone arms it; dropping there removes the card", () => {
  const { canvas, hover, deleted, layouts } = mount();
  canvas.setCards("t1", entries("a", "b"), null);
  deleteZone(canvas);
  layouts.length = 0;
  const a = cardEl(canvas, "a");

  down(a, 0, 0);
  move(a, 550, 20); // inside the delete zone
  assert.equal(hover.at(-1), true, "delete zone armed");
  assert.ok(a.classList.contains("detail-card--will-delete"));

  up(a, 550, 20);
  assert.deepEqual(deleted, ["a"], "the card was removed, not moved");
  assert.equal(layouts.length, 0, "no layout change on a delete drop");
  assert.equal(hover.at(-1), false, "delete zone restored after the drop");
});

test("leaving the delete zone restores the selector and resumes snapping", () => {
  const { canvas, hover, deleted } = mount();
  canvas.setCards("t1", entries("a", "b"), null);
  deleteZone(canvas);
  const a = cardEl(canvas, "a");
  const snap = canvas.element.querySelector(".card-grid-ghost--snap");

  down(a, 0, 0);
  move(a, 550, 20); // over the zone
  assert.equal(hover.at(-1), true);
  move(a, 2 * 166, 0); // back over the canvas, cell (2,0)
  assert.equal(hover.at(-1), false, "selector restored");
  assert.equal(snap.hidden, false, "snap ghost resumes over the grid");

  up(a, 2 * 166, 0);
  assert.deepEqual(deleted, [], "a normal drop, not a delete");
  assert.equal(transform(canvas, "a"), `translate(${cellLeft(2)}px, 0px)`);
});

test("switching tunnels adopts the incoming stored layout", () => {
  const { canvas } = mount();
  canvas.setCards("t1", entries("a", "b"), null); // a at (0,0)
  canvas.setCards("t2", entries("a", "b"), {
    a: { col: 3, row: 2 },
    b: { col: 0, row: 0 },
  });
  assert.equal(
    transform(canvas, "a"),
    `translate(${cellLeft(3)}px, ${cellTop(2)}px)`,
    "t2's stored cell for 'a' was restored",
  );
});
