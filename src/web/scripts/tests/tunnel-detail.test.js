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

// tunnel-detail.test.js — the detail panel: the route breadcrumb (direct + jump
// chain), the arm/pause controls, the stat cards' values, and the snap-to-grid
// canvas (reading-order placement, drag snap/swap, and return-home).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { TunnelDetail } from "../components/tunnel-detail.js";
import {
  reorderCards,
  visibleCards,
  hiddenCards,
  DEFAULT_CARD_ORDER,
} from "../components/card-catalog.js";
import { cellLeft, cellTop } from "../components/grid-layout.js";

const NOW = 1_000_000;

function mount(opts = {}) {
  resetDom();
  const calls = { arm: [], pause: [], change: [], layout: [] };
  const detail = new TunnelDetail({
    now: () => NOW,
    onToggleArm: (id) => calls.arm.push(id),
    onTogglePause: (id) => calls.pause.push(id),
    onCardsChange: (order) => calls.change.push(order),
    onLayoutChange: (id, positions) => calls.layout.push({ id, positions }),
    ...opts,
  });
  document.body.appendChild(detail.element);
  return { detail, calls };
}

/** The {col,row} a card currently sits at, parsed from its inline transform. */
function cellOf(detail, key) {
  const node = detail.element.querySelector(`.detail-card[data-card="${key}"]`);
  const m = /translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/.exec(
    node.style.transform || "",
  );
  return { x: Number(m?.[1] ?? 0), y: Number(m?.[2] ?? 0) };
}

/** Pointer-drag a card (grabbed at its top-left) onto the cell (col,row). */
function dragTo(detail, key, col, row) {
  const node = detail.element.querySelector(`.detail-card[data-card="${key}"]`);
  const from = cellOf(detail, key);
  const to = { x: cellLeft(col), y: cellTop(row) };
  node.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      clientX: from.x,
      clientY: from.y,
      button: 0,
      bubbles: true,
    }),
  );
  // Move/up are captured on the card element (see CardCanvas#pointerDown).
  node.dispatchEvent(
    new window.MouseEvent("pointermove", { clientX: to.x, clientY: to.y }),
  );
  node.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: to.x, clientY: to.y }),
  );
}

const DEF = { id: "t1", localPort: 1, destination: { host: "h", port: 2 } };

const cards = (el) =>
  [...el.querySelectorAll(".detail-card")].map((c) => c.dataset.card);
const routeText = (el) =>
  [...el.querySelectorAll(".route-seg")].map((s) => s.textContent);

// ── Pure helpers ────────────────────────────────────────────────────────────

test("reorderCards moves a key to the target slot", () => {
  assert.deepEqual(reorderCards(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(reorderCards(["a", "b", "c"], "a", "c"), ["b", "a", "c"]);
  assert.deepEqual(reorderCards(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
});

test("visibleCards treats a saved array as the visible set (no appending)", () => {
  // A saved subset is exactly the visible cards — the rest are hidden.
  assert.deepEqual(visibleCards(["errors", "download"]), [
    "errors",
    "download",
  ]);
  // Unknown keys dropped, de-duped.
  assert.deepEqual(visibleCards(["download", "bogus", "download"]), [
    "download",
  ]);
  // First run (no saved value) shows every card.
  assert.deepEqual(visibleCards(undefined), [...DEFAULT_CARD_ORDER]);
  // An empty array is honoured (the user hid them all).
  assert.deepEqual(visibleCards([]), []);
});

test("hiddenCards is the default-order complement of the visible set", () => {
  const hidden = hiddenCards(["download", "upload"]);
  assert.ok(!hidden.includes("download"));
  assert.ok(hidden.includes("errors"));
  assert.equal(hidden.length, DEFAULT_CARD_ORDER.length - 2);
});

// ── Breadcrumb ──────────────────────────────────────────────────────────────

test("breadcrumb of a direct tunnel is local → target", () => {
  const { detail } = mount();
  detail.show(
    {
      id: "t1",
      bindHost: "127.0.0.1",
      localPort: 18001,
      destination: { host: "127.0.0.1", port: 7000 },
    },
    { state: "disarmed" },
  );
  assert.deepEqual(routeText(detail.element), [
    "127.0.0.1:18001",
    "127.0.0.1:7000",
  ]);
  assert.ok(
    detail.element
      .querySelector(".route-seg--target")
      .textContent.includes("7000"),
  );
});

test("breadcrumb of a jump-chain is local → jump → ssh server → target", () => {
  const { detail } = mount();
  const jumpsById = new Map([
    ["j1", { id: "j1", label: "Docker jump", host: "127.0.0.1", port: 2201 }],
  ]);
  detail.show(
    {
      id: "t2",
      bindHost: "127.0.0.1",
      localPort: 18002,
      jumpHostIds: ["j1"],
      sshHost: "172.29.0.12",
      sshPort: 22,
      destination: { host: "127.0.0.1", port: 7000 },
    },
    { state: "connected", jumpsById },
  );
  assert.deepEqual(routeText(detail.element), [
    "127.0.0.1:18002",
    "Docker jump",
    "172.29.0.12:22",
    "127.0.0.1:7000",
  ]);
});

// ── Controls ────────────────────────────────────────────────────────────────

test("arm control reflects state and fires the intent", () => {
  const { detail, calls } = mount();
  detail.show(
    { id: "t1", localPort: 1, destination: { host: "h", port: 2 } },
    { state: "disarmed" },
  );
  const armBtn = detail.element.querySelector(".detail-arm-btn");
  assert.ok(!armBtn.classList.contains("detail-arm-btn--armed"));

  detail.updateState("connected");
  assert.ok(
    armBtn.classList.contains("detail-arm-btn--armed"),
    "armed when connected",
  );

  armBtn.click();
  assert.deepEqual(calls.arm, ["t1"]);
});

test("pause control is disabled unless connected/paused and fires the intent", () => {
  const { detail, calls } = mount();
  detail.show(
    { id: "t1", localPort: 1, destination: { host: "h", port: 2 } },
    { state: "listening" },
  );
  const pauseBtn = detail.element.querySelector(".detail-pause-btn");
  assert.equal(pauseBtn.disabled, true, "can't pause a listening tunnel");

  detail.updateState("connected");
  assert.equal(pauseBtn.disabled, false);
  pauseBtn.click();
  assert.deepEqual(calls.pause, ["t1"]);
});

// ── Cards ───────────────────────────────────────────────────────────────────

test("cards render values from the snapshot, incl. the new counters", () => {
  const { detail } = mount();
  detail.show(
    { id: "t1", localPort: 1, destination: { host: "h", port: 2 } },
    {
      state: "connected",
      snap: {
        rateDown: 1500,
        rateUp: 300,
        activeConnections: 3,
        connectionCount: 9,
        errorCount: 2,
        totalBytes: 2048,
        bytesUp: 1024,
        bytesDown: 1024,
        openedAt: NOW - 5000,
        firstConnectedAt: NOW - 60000,
        lastDisconnectedAt: NOW - 120000,
        lastActiveAt: NOW - 2000,
      },
    },
  );
  const value = (key) =>
    detail.element.querySelector(`.detail-card[data-card="${key}"] .card-value`)
      .textContent;

  assert.match(value("download"), /\/s$/);
  assert.equal(value("connections"), "3");
  assert.equal(value("connectionCount"), "9");
  assert.equal(value("errors"), "2");
  assert.equal(value("state"), "Connected");

  // A non-zero error count is toned danger; zero is not.
  const errEl = detail.element.querySelector(
    '.detail-card[data-card="errors"] .card-value',
  );
  assert.ok(errEl.classList.contains("card-value--error"));
});

// ── Error card → full-error dialog ────────────────────────────────────────────

test("the State card becomes an activatable error button only while errored", () => {
  const { detail, calls } = mount({ onShowError: (id) => calls.err.push(id) });
  calls.err = [];
  detail.show(DEF, { state: "connected" });

  const stateCard = () =>
    detail.element.querySelector('.detail-card[data-card="state"]');

  // Not errored → inert display card, and a click does nothing.
  assert.ok(!stateCard().classList.contains("detail-card--error"));
  assert.equal(stateCard().getAttribute("role"), "listitem");
  stateCard().click();
  assert.deepEqual(calls.err, []);

  // Errored → clickable, focusable, and a click reports the tunnel id.
  detail.updateState("error");
  assert.ok(stateCard().classList.contains("detail-card--error"));
  assert.equal(stateCard().getAttribute("role"), "button");
  assert.equal(stateCard().getAttribute("tabindex"), "0");
  stateCard().click();
  assert.deepEqual(calls.err, ["t1"]);

  // Recovering clears the affordance again.
  detail.updateState("connected");
  assert.ok(!stateCard().classList.contains("detail-card--error"));
  assert.equal(stateCard().getAttribute("tabindex"), null);
});

test("the Errors card becomes an activatable button only when the count is non-zero", () => {
  const { detail, calls } = mount({
    onShowErrors: (id) => calls.errs.push(id),
  });
  calls.errs = [];
  detail.show(DEF, { state: "connected", snap: { errorCount: 0 } });

  const errorsCard = () =>
    detail.element.querySelector('.detail-card[data-card="errors"]');

  // Zero errors → inert, and a click does nothing.
  assert.ok(!errorsCard().classList.contains("detail-card--clickable"));
  errorsCard().click();
  assert.deepEqual(calls.errs, []);

  // A non-zero count → clickable, and a click reports the tunnel id.
  detail.updateSnap({ errorCount: 3 }, "connected");
  assert.ok(errorsCard().classList.contains("detail-card--clickable"));
  assert.equal(errorsCard().getAttribute("role"), "button");
  errorsCard().click();
  assert.deepEqual(calls.errs, ["t1"]);
});

test("Enter/Space on the errored State card also opens the error", () => {
  const { detail, calls } = mount({ onShowError: (id) => calls.err.push(id) });
  calls.err = [];
  detail.show(DEF, { state: "error" });
  const stateCard = detail.element.querySelector(
    '.detail-card[data-card="state"]',
  );
  stateCard.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.deepEqual(calls.err, ["t1"]);
});

test("the errors card is not red when the count is zero", () => {
  const { detail } = mount();
  detail.show(
    { id: "t1", localPort: 1, destination: { host: "h", port: 2 } },
    { state: "listening", snap: { errorCount: 0 } },
  );
  const errEl = detail.element.querySelector(
    '.detail-card[data-card="errors"] .card-value',
  );
  assert.ok(!errEl.classList.contains("card-value--error"));
});

test("empty state shows until a tunnel is selected", () => {
  const { detail } = mount();
  assert.equal(detail.element.querySelector(".detail-content").hidden, true);
  assert.equal(detail.element.querySelector(".detail-empty").hidden, false);
  detail.show(
    { id: "t1", localPort: 1, destination: { host: "h", port: 2 } },
    { state: "disarmed" },
  );
  assert.equal(detail.element.querySelector(".detail-content").hidden, false);
  detail.clear();
  assert.equal(detail.element.querySelector(".detail-content").hidden, true);
});

// ── Snap-to-grid canvas: drag, swap, return-home ─────────────────────────────

test("a fresh tunnel places its cards in reading order across the grid", () => {
  const { detail } = mount();
  detail.setCardOrder(["download", "upload", "connections", "transferred"]);
  detail.show(DEF, { state: "disarmed" });
  // 4 columns → row 0 fills left→right.
  assert.deepEqual(cellOf(detail, "download"), {
    x: cellLeft(0),
    y: cellTop(0),
  });
  assert.deepEqual(cellOf(detail, "upload"), { x: cellLeft(1), y: cellTop(0) });
  assert.deepEqual(cellOf(detail, "connections"), {
    x: cellLeft(2),
    y: cellTop(0),
  });
});

test("dragging a card onto a free cell snaps it there and persists the layout", () => {
  const { detail, calls } = mount();
  detail.setCardOrder(["download", "upload"]); // (0,0) and (1,0); (2,0) is free
  detail.show(DEF, { state: "disarmed" });
  calls.layout.length = 0;

  dragTo(detail, "download", 2, 0);

  assert.deepEqual(cellOf(detail, "download"), {
    x: cellLeft(2),
    y: cellTop(0),
  });
  assert.ok(calls.layout.length >= 1, "layout change reported");
  const last = calls.layout.at(-1);
  assert.equal(last.id, "t1");
  assert.deepEqual(last.positions.download, { col: 2, row: 0 });
});

test("dropping onto an occupied cell swaps the two cards", () => {
  const { detail } = mount();
  detail.setCardOrder(["download", "upload", "connections"]);
  detail.show(DEF, { state: "disarmed" }); // download(0,0) upload(1,0) connections(2,0)

  dragTo(detail, "download", 2, 0); // onto connections

  assert.deepEqual(cellOf(detail, "download"), {
    x: cellLeft(2),
    y: cellTop(0),
  });
  assert.deepEqual(
    cellOf(detail, "connections"),
    { x: cellLeft(0), y: cellTop(0) },
    "the occupant took the dragged card's origin cell",
  );
});

test("a displaced card returns home once the intruder leaves its cell", () => {
  const { detail } = mount();
  detail.setCardOrder(["download", "upload", "connections"]);
  detail.show(DEF, { state: "disarmed" }); // download(0,0) upload(1,0) connections(2,0)

  // Swap download onto connections: connections is displaced to (0,0), home (2,0).
  dragTo(detail, "download", 2, 0);
  assert.deepEqual(cellOf(detail, "connections"), {
    x: cellLeft(0),
    y: cellTop(0),
  });

  // Move download away to a free cell (3,0) → (2,0) frees → connections returns.
  dragTo(detail, "download", 3, 0);
  assert.deepEqual(
    cellOf(detail, "connections"),
    { x: cellLeft(2), y: cellTop(0) },
    "connections animated back to its home cell",
  );
  assert.deepEqual(cellOf(detail, "download"), {
    x: cellLeft(3),
    y: cellTop(0),
  });
});

test("dragging a card onto the Data Fields selector removes and deselects it", () => {
  const { detail, calls } = mount();
  detail.setCardOrder(["download", "upload", "connections"]);
  detail.show(DEF, { state: "disarmed" });
  // Give the selector (outside the canvas) a real client rect to hit-test.
  const zone = detail.element.querySelector(".detail-cards-menu-wrap");
  zone.getBoundingClientRect = () => ({
    left: 500,
    top: 0,
    right: 620,
    bottom: 40,
    width: 120,
    height: 40,
  });
  calls.change.length = 0;

  const node = detail.element.querySelector(
    '.detail-card[data-card="download"]',
  );
  const btn = detail.element.querySelector(".detail-cards-btn");
  node.dispatchEvent(
    new window.MouseEvent("pointerdown", {
      clientX: 0,
      clientY: 0,
      button: 0,
      bubbles: true,
    }),
  );
  node.dispatchEvent(
    new window.MouseEvent("pointermove", { clientX: 550, clientY: 20 }),
  );
  // Over the selector: it arms as a trash target.
  assert.ok(
    btn.classList.contains("detail-cards-btn--delete"),
    "selector armed as a delete target",
  );

  node.dispatchEvent(
    new window.MouseEvent("pointerup", { clientX: 550, clientY: 20 }),
  );
  // The card is gone from the grid and deselected (persisted via onCardsChange).
  assert.ok(!cards(detail.element).includes("download"));
  assert.deepEqual(calls.change.at(-1), ["upload", "connections"]);
  // The selector is restored (no longer a delete target).
  assert.ok(!btn.classList.contains("detail-cards-btn--delete"));
});

test("toggling a card off frees its cell without re-packing the rest", () => {
  const { detail } = mount();
  detail.setCardOrder(["download", "upload", "connections"]);
  detail.show(DEF, { state: "disarmed" });
  const uploadCell = cellOf(detail, "upload");

  detail.setCardOrder(["upload", "connections"]); // drop download from the middle
  // Survivors keep their exact cells — no reflow into the freed (0,0) gap.
  assert.deepEqual(cellOf(detail, "upload"), uploadCell);
  assert.deepEqual(cellOf(detail, "connections"), {
    x: cellLeft(2),
    y: cellTop(0),
  });
});

// ── Choose which cards show (per-card [X] + the checklist menu) ────────────────

test("only the saved visible cards render; the rest are hidden", () => {
  const { detail } = mount();
  detail.setCardOrder(["download", "state"]);
  detail.show(DEF, { state: "connected" });
  assert.deepEqual(cards(detail.element), ["download", "state"]);
});

test("the Cards menu adds and removes cards, re-adding at the end", () => {
  const { detail, calls } = mount();
  detail.show(DEF, { state: "disarmed" });

  // Open the menu.
  const btn = detail.element.querySelector(".detail-cards-btn");
  btn.click();
  assert.equal(detail.element.querySelector(".card-menu").hidden, false);

  const box = (key) =>
    detail.element.querySelector(`.card-menu-check[data-card="${key}"]`);

  // Uncheck "errors" → it disappears from the grid.
  box("errors").checked = false;
  box("errors").dispatchEvent(new Event("change", { bubbles: true }));
  assert.ok(!cards(detail.element).includes("errors"));

  // Re-check it → it comes back at the END of the grid.
  box("errors").checked = true;
  box("errors").dispatchEvent(new Event("change", { bubbles: true }));
  assert.equal(cards(detail.element).at(-1), "errors", "re-added at the end");
  assert.deepEqual(calls.change.at(-1), cards(detail.element));
});

test("hiding every card shows the empty hint", () => {
  const { detail } = mount();
  detail.setCardOrder([]); // nothing visible
  detail.show(DEF, { state: "disarmed" });
  assert.equal(cards(detail.element).length, 0);
  assert.ok(detail.element.querySelector(".detail-cards-empty"));
});
