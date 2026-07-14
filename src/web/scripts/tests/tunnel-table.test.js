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

// tunnel-table.test.js — the "list" view: an identity column plus one column per
// visible card, a row per tunnel; click-to-sort (reverses on the sorted column),
// drag-to-reorder columns (persists the shared card order), the "Cards" checklist
// as the column chooser, and in-place live-value updates.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import {
  TunnelTable,
  TABLE_TUNNEL_COLUMN,
  normalizeSort,
} from "../components/tunnel-table.js";

const NOW = 2_000_000;

const DEFS = [
  {
    id: "a",
    name: "Charlie",
    localPort: 18003,
    destination: { host: "h", port: 1 },
  },
  {
    id: "b",
    name: "alpha",
    localPort: 18001,
    destination: { host: "h", port: 2 },
  },
  {
    id: "c",
    name: "Bravo",
    localPort: 18002,
    destination: { host: "h", port: 3 },
  },
];

const STATES = new Map([
  ["a", "connected"],
  ["b", "listening"],
  ["c", "paused"],
]);

const SNAPS = new Map([
  ["a", { id: "a", rateDown: 300, activeConnections: 2, errorCount: 0 }],
  ["b", { id: "b", rateDown: 100, activeConnections: 5, errorCount: 1 }],
  ["c", { id: "c", rateDown: 200, activeConnections: 0, errorCount: 0 }],
]);

function mount() {
  resetDom();
  const calls = {
    select: [],
    add: [],
    edit: [],
    delete: [],
    cards: [],
    sort: [],
    arm: [],
    pause: [],
  };
  const table = new TunnelTable({
    now: () => NOW,
    onSelect: (id) => calls.select.push(id),
    onAdd: () => calls.add.push(true),
    onEdit: (id) => calls.edit.push(id),
    onDelete: (id) => calls.delete.push(id),
    onCardsChange: (o) => calls.cards.push(o),
    onSortChange: (s) => calls.sort.push(s),
    onToggleArm: (id) => calls.arm.push(id),
    onTogglePause: (id) => calls.pause.push(id),
  });
  document.body.appendChild(table.element);
  return { table, calls };
}

const headerCols = (table) =>
  [...table.element.querySelectorAll(".tt-th")].map((th) => th.dataset.col);
const rowIds = (table) =>
  [...table.element.querySelectorAll(".tt-row")].map((tr) => tr.dataset.id);
const th = (table, col) =>
  table.element.querySelector(`.tt-th[data-col="${col}"]`);
const metricCell = (table, id) =>
  table.element.querySelector(`.tt-row[data-id="${id}"] .tt-td--metric`);

// ── normalizeSort (pure) ─────────────────────────────────────────────────────

test("normalizeSort coerces to a valid { key, dir }", () => {
  assert.deepEqual(normalizeSort(undefined), {
    key: TABLE_TUNNEL_COLUMN,
    dir: "asc",
  });
  assert.deepEqual(normalizeSort({ key: "download", dir: "desc" }), {
    key: "download",
    dir: "desc",
  });
  assert.deepEqual(normalizeSort({ key: "x", dir: "bogus" }), {
    key: "x",
    dir: "asc",
  });
});

// ── Structure ────────────────────────────────────────────────────────────────

test("renders an identity column, one column per visible card, and a row per tunnel", () => {
  const { table } = mount();
  table.setCardOrder(["download", "connections"]);
  table.setData(DEFS, STATES, SNAPS, "a");
  assert.deepEqual(headerCols(table), [
    TABLE_TUNNEL_COLUMN,
    "download",
    "connections",
  ]);
  assert.equal(table.element.querySelectorAll(".tt-row").length, 3);
});

test("the identity cell shows the status dot, local port and name", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  const rowA = table.element.querySelector('.tt-row[data-id="a"]');
  assert.ok(rowA.querySelector(".tunnel-dot--armed"), "connected → armed dot");
  assert.equal(rowA.querySelector(".tunnel-row-port").textContent, "18003");
  assert.ok(rowA.textContent.includes("Charlie"));
});

test("metric cells render the card values", () => {
  const { table } = mount();
  table.setCardOrder(["connections"]);
  table.setData(DEFS, STATES, SNAPS, "a");
  assert.equal(metricCell(table, "b").textContent, "5");
  assert.equal(metricCell(table, "c").textContent, "0");
});

// ── Sorting ──────────────────────────────────────────────────────────────────

test("rows sort by name ascending by default (case-insensitive)", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  assert.deepEqual(rowIds(table), ["b", "c", "a"]); // alpha, Bravo, Charlie
});

test("clicking the sorted identity header reverses the order", () => {
  const { table, calls } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  th(table, TABLE_TUNNEL_COLUMN).click();
  assert.deepEqual(rowIds(table), ["a", "c", "b"]); // Charlie, Bravo, alpha
  assert.equal(
    th(table, TABLE_TUNNEL_COLUMN).getAttribute("aria-sort"),
    "descending",
  );
  assert.deepEqual(calls.sort.at(-1), {
    key: TABLE_TUNNEL_COLUMN,
    dir: "desc",
  });
});

test("clicking a metric header sorts by it (asc), then reverses", () => {
  const { table } = mount();
  table.setCardOrder(["download"]);
  table.setData(DEFS, STATES, SNAPS, "a");

  th(table, "download").click(); // asc by rateDown: b(100), c(200), a(300)
  assert.deepEqual(rowIds(table), ["b", "c", "a"]);
  assert.equal(th(table, "download").getAttribute("aria-sort"), "ascending");
  assert.equal(
    th(table, "download").querySelector(".tt-th-arrow").textContent,
    "▲",
  );

  th(table, "download").click(); // desc: a, c, b
  assert.deepEqual(rowIds(table), ["a", "c", "b"]);
  assert.equal(
    th(table, "download").querySelector(".tt-th-arrow").textContent,
    "▼",
  );
});

// ── Column drag reorder ──────────────────────────────────────────────────────

test("dragging a metric header onto another reorders columns and reports it", () => {
  const { table, calls } = mount();
  table.setCardOrder(["download", "upload", "connections"]);
  table.setData(DEFS, STATES, SNAPS, "a");

  th(table, "connections").dispatchEvent(
    new Event("dragstart", { bubbles: true }),
  );
  th(table, "download").dispatchEvent(new Event("drop", { bubbles: true }));

  assert.deepEqual(headerCols(table), [
    TABLE_TUNNEL_COLUMN,
    "connections",
    "download",
    "upload",
  ]);
  assert.deepEqual(calls.cards.at(-1), ["connections", "download", "upload"]);
});

test("the identity header is not draggable; metric headers are", () => {
  const { table } = mount();
  table.setCardOrder(["download"]);
  table.setData(DEFS, STATES, SNAPS, "a");
  assert.equal(th(table, TABLE_TUNNEL_COLUMN).draggable, false);
  assert.equal(th(table, "download").draggable, true);
});

// ── Column chooser (shared "Cards" checklist) ───────────────────────────────

test("unchecking a card in the Cards menu removes its column", () => {
  const { table, calls } = mount();
  table.setCardOrder(["download", "connections"]);
  table.setData(DEFS, STATES, SNAPS, "a");

  table.element.querySelector(".detail-cards-btn").click();
  const dl = table.element.querySelector(
    '.card-menu-check[data-card="download"]',
  );
  dl.checked = false;
  dl.dispatchEvent(new Event("change", { bubbles: true }));

  assert.deepEqual(headerCols(table), [TABLE_TUNNEL_COLUMN, "connections"]);
  assert.deepEqual(calls.cards.at(-1), ["connections"]);
});

// ── Live updates ─────────────────────────────────────────────────────────────

test("applyStats updates metric cells in place without a re-sort", () => {
  const { table } = mount();
  table.setCardOrder(["connections"]);
  table.setSort({ key: TABLE_TUNNEL_COLUMN, dir: "asc" });
  table.setData(DEFS, STATES, SNAPS, "a");
  assert.deepEqual(rowIds(table), ["b", "c", "a"]);
  assert.equal(metricCell(table, "b").textContent, "5");

  const snaps2 = new Map([
    ["a", { id: "a", activeConnections: 2 }],
    ["b", { id: "b", activeConnections: 9 }],
    ["c", { id: "c", activeConnections: 0 }],
  ]);
  table.applyStats(snaps2, STATES);
  assert.equal(metricCell(table, "b").textContent, "9");
  assert.deepEqual(rowIds(table), ["b", "c", "a"], "order unchanged");
});

test("updateState re-tones the row's dot", () => {
  const { table } = mount();
  table.setCardOrder([]);
  // Clone: updateState mutates the passed-in states map — keep the shared one clean.
  table.setData(DEFS, new Map(STATES), SNAPS, "a");
  table.updateState("b", "error");
  const rowB = table.element.querySelector('.tt-row[data-id="b"]');
  assert.ok(rowB.querySelector(".tunnel-dot--error"));
});

// ── Selection + actions ──────────────────────────────────────────────────────

test("setSelected highlights the row; a row click reports the selection", () => {
  const { table, calls } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  table.setSelected("c");
  assert.ok(
    table.element
      .querySelector('.tt-row[data-id="c"]')
      .classList.contains("tt-row--selected"),
  );

  table.element.querySelector('.tt-row[data-id="a"]').click();
  assert.deepEqual(calls.select, ["a"]);
});

test("Add + edit report without selecting the row; delete is context-menu only", () => {
  const { table, calls } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");

  table.element.querySelector(".tunnel-add-btn").click();
  assert.equal(calls.add.length, 1);

  const rowA = table.element.querySelector('.tt-row[data-id="a"]');
  rowA.querySelector(".tunnel-edit-btn").click();
  assert.deepEqual(calls.edit, ["a"]);
  assert.equal(calls.select.length, 0, "edit stops propagation");

  // Delete moved to the row context menu — no inline delete button in list view.
  assert.equal(
    rowA.querySelector(".tunnel-delete-btn"),
    null,
    "no inline delete button in list view",
  );
});

// ── Selected-tunnel arm/pause controls (toolbar) ─────────────────────────────

test("the toolbar arm/pause controls reflect and drive the selected tunnel", () => {
  const { table, calls } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a"); // 'a' is connected
  const armBtn = table.element.querySelector(".detail-arm-btn");
  const pauseBtn = table.element.querySelector(".detail-pause-btn");
  assert.ok(
    armBtn.classList.contains("detail-arm-btn--armed"),
    "connected → armed",
  );
  assert.equal(pauseBtn.disabled, false, "connected → can pause");

  pauseBtn.click();
  armBtn.click();
  assert.deepEqual(calls.pause, ["a"]);
  assert.deepEqual(calls.arm, ["a"]);
});

test("the arm/pause controls are disabled when no row is selected", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, null);
  assert.equal(table.element.querySelector(".detail-arm-btn").disabled, true);
  assert.equal(table.element.querySelector(".detail-pause-btn").disabled, true);
});

test("pause is disabled for a selected tunnel that isn't connected/paused", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "b"); // 'b' is listening
  assert.ok(
    table.element
      .querySelector(".detail-arm-btn")
      .classList.contains("detail-arm-btn--armed"),
    "listening → armed",
  );
  assert.equal(
    table.element.querySelector(".detail-pause-btn").disabled,
    true,
    "listening → can't pause",
  );
});

test("selecting another row re-targets the controls to that tunnel", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  table.setSelected("c"); // 'c' is paused
  const pauseBtn = table.element.querySelector(".detail-pause-btn");
  assert.equal(pauseBtn.disabled, false, "paused → can resume");
  assert.equal(pauseBtn.getAttribute("aria-label"), "Resume traffic");
});

test("a live state change updates the selected tunnel's controls", () => {
  const { table } = mount();
  table.setCardOrder([]);
  // Clone: updateState mutates the passed-in states map — keep the shared one clean.
  table.setData(DEFS, new Map(STATES), SNAPS, "b"); // listening → can't pause
  assert.equal(table.element.querySelector(".detail-pause-btn").disabled, true);
  table.updateState("b", "connected");
  assert.equal(
    table.element.querySelector(".detail-pause-btn").disabled,
    false,
  );
});

// ── Empty state ──────────────────────────────────────────────────────────────

test("no tunnels shows the empty hint and hides the table", () => {
  const { table } = mount();
  table.setData([], new Map(), new Map(), null);
  assert.equal(
    table.element.querySelector(".tunnel-table-empty").hidden,
    false,
  );
  assert.equal(table.element.querySelector(".tunnel-table").hidden, true);
});
