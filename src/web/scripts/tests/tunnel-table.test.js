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
import { t } from "../i18n.js";

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

test("the identity cell shows the status signal and name", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");
  const rowA = table.element.querySelector('.tt-row[data-id="a"]');
  assert.ok(
    rowA.querySelector(".tunnel-signal--green"),
    "connected → green lamp",
  );
  assert.equal(rowA.querySelector(".tunnel-row-port"), null);
  assert.ok(rowA.textContent.includes("Charlie"));
});

test("the identity cell carries a forwarding-type icon per tunnel (parity with the sidebar)", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(
    [
      { id: "a", name: "Local", destination: { host: "h", port: 1 } },
      { id: "b", name: "Reverse", type: "remote" },
      { id: "c", name: "Proxy", type: "dynamic" },
    ],
    new Map(),
    new Map(),
  );
  const icon = (id) =>
    table.element.querySelector(`.tt-row[data-id="${id}"] .tunnel-type-icon`);

  assert.ok(icon("a").classList.contains("tunnel-type-icon--local"));
  assert.ok(icon("a").querySelector("svg"), "the glyph is an inline SVG");
  assert.equal(icon("a").getAttribute("aria-label"), t("editor.type.local"));
  assert.ok(icon("b").classList.contains("tunnel-type-icon--remote"));
  assert.ok(icon("c").classList.contains("tunnel-type-icon--dynamic"));
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

test("updateState relights the row's signal", () => {
  const { table } = mount();
  table.setCardOrder([]);
  // Clone: updateState mutates the passed-in states map — keep the shared one clean.
  table.setData(DEFS, new Map(STATES), SNAPS, "a");
  table.updateState("b", "error");
  const rowB = table.element.querySelector('.tt-row[data-id="b"]');
  assert.ok(rowB.querySelector(".tunnel-signal--red"));
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

test("Add reports without selecting; edit + delete are context-menu only", () => {
  const { table, calls } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "a");

  table.element.querySelector(".tunnel-add-btn").click();
  assert.equal(calls.add.length, 1);

  // Edit + delete moved to the row context menu — no inline row buttons in list view.
  const rowA = table.element.querySelector('.tt-row[data-id="a"]');
  assert.equal(
    rowA.querySelector(".tunnel-edit-btn"),
    null,
    "no inline edit button in list view",
  );
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
  const armSwitch = table.element.querySelector(".detail-arm-switch");
  const pauseBtn = table.element.querySelector(".detail-pause-btn");
  assert.equal(armSwitch.checked, true, "connected → armed");
  assert.equal(pauseBtn.disabled, false, "connected → can pause");

  pauseBtn.click();
  armSwitch.click();
  assert.deepEqual(calls.pause, ["a"]);
  assert.deepEqual(calls.arm, ["a"]);
});

test("the arm/pause controls are disabled when no row is selected", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, null);
  assert.equal(
    table.element.querySelector(".detail-arm-switch").disabled,
    true,
  );
  assert.equal(table.element.querySelector(".detail-pause-btn").disabled, true);
});

test("pause is disabled for a selected tunnel that isn't connected/paused", () => {
  const { table } = mount();
  table.setCardOrder([]);
  table.setData(DEFS, STATES, SNAPS, "b"); // 'b' is listening
  assert.equal(
    table.element.querySelector(".detail-arm-switch").checked,
    true,
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

// ── Grouping (Feature 140) ───────────────────────────────────────────────────

const groupRows = (table) => [
  ...table.element.querySelectorAll(".tt-group-row"),
];

test("with no groups the table renders flat (no group header rows)", () => {
  const { table } = mount();
  table.setData(DEFS, STATES, SNAPS, "a");
  table.setGrouping({ groups: [], collapsedIds: [] });
  assert.equal(groupRows(table).length, 0);
  assert.equal(rowIds(table).length, 3);
});

test("renders a group header row (spanning all columns) + an Ungrouped section", () => {
  const { table } = mount();
  table.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B" },
    ],
    new Map([
      ["a", "connected"],
      ["b", "disarmed"],
    ]),
    new Map(),
    "a",
  );
  table.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const gr = groupRows(table);
  assert.equal(gr.length, 2, "Work + Ungrouped");
  // The name + controls live in a cell pinned to the identity column; an empty
  // filler spans the rest, so together they still cover every column.
  const cells = [...gr[0].querySelectorAll(".tt-group-cell")];
  const cols = headerCols(table).length;
  const totalSpan = cells.reduce(
    (n, c) => n + (Number(c.getAttribute("colspan")) || 1),
    0,
  );
  assert.equal(totalSpan, cols, "spans every column");
  const identity = gr[0].querySelector(".tt-group-cell--identity");
  assert.equal(identity.querySelector(".group-name").textContent, "Work");
  assert.equal(identity.querySelector(".group-count").textContent, "1/1");
  // Controls sit in the same (name) cell, to its right.
  assert.ok(
    identity.querySelector(".group-arm-switch"),
    "arm switch in name cell",
  );
});

test("a collapsed group hides its rows but keeps the header row", () => {
  const { table } = mount();
  table.setData([{ id: "a", name: "A", groupId: "g1" }], new Map(), new Map());
  table.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: ["g1"],
  });
  assert.equal(groupRows(table).length, 1);
  assert.equal(rowIds(table).length, 0, "the group's row is hidden");
});

test("the group header arm switch fires an action; header click toggles collapse", () => {
  const calls = { action: [], collapse: [] };
  const table = new TunnelTable({
    now: () => NOW,
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: (sid) => calls.collapse.push(sid),
  });
  document.body.appendChild(table.element);
  table.setData([{ id: "a", name: "A", groupId: "g1" }], new Map(), new Map());
  table.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const header = table.element.querySelector(
    '.tt-group-row[data-section="g1"]',
  );
  header
    .querySelector(".group-arm-switch")
    .dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(calls.action, [["g1", "arm"]]);
  header.click();
  assert.deepEqual(calls.collapse, ["g1"]);
});

test("the group arm switch reads live state, not a stale header snapshot", () => {
  const calls = { action: [] };
  const table = new TunnelTable({
    now: () => NOW,
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(table.element);
  table.setData([{ id: "a", name: "A", groupId: "g1" }], new Map(), new Map());
  table.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const sw = table.element
    .querySelector('.tt-group-row[data-section="g1"]')
    .querySelector(".group-arm-switch");
  sw.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(calls.action, [["g1", "arm"]], "all disarmed → arm all");
  // A live broadcast arms the tunnel (in-place refresh, no full re-render).
  table.updateState("a", "connected");
  sw.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(
    calls.action[1],
    ["g1", "disarm"],
    "now fully armed → disarm all (not a stale re-arm)",
  );
});

test("the group header row has a pause/resume icon acting on the whole group", () => {
  const calls = { action: [] };
  const table = new TunnelTable({
    now: () => NOW,
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(table.element);
  table.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B", groupId: "g1" },
    ],
    new Map([
      ["a", "connected"],
      ["b", "disarmed"],
    ]),
    new Map(),
  );
  table.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const btn = () =>
    table.element
      .querySelector('.tt-group-row[data-section="g1"]')
      .querySelector(".group-pause-btn");
  assert.ok(btn(), "the pause icon renders");
  assert.equal(btn().disabled, false, "enabled while a tunnel is connected");
  btn().click();
  assert.deepEqual(calls.action, [["g1", "pause"]], "connected → pause all");

  table.updateState("a", "paused");
  assert.equal(btn().getAttribute("aria-label"), t("group.resumeAll"));
  btn().click();
  assert.deepEqual(
    calls.action[1],
    ["g1", "resume"],
    "all paused → resume all",
  );

  table.updateState("a", "disarmed");
  assert.equal(btn().disabled, true, "disabled when nothing is pausable");
  btn().click();
  assert.equal(calls.action.length, 2, "a disabled click does nothing");
});

function mountGroupedTable(calls) {
  const table = new TunnelTable({
    now: () => NOW,
    onAssignToGroup: (id, gid) => calls.assign.push([id, gid]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(table.element);
  table.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B", groupId: "g2" },
      { id: "c", name: "C", groupId: "g2" },
    ],
    new Map(),
    new Map(),
  );
  table.setGrouping({
    groups: [
      { id: "g1", label: "One", color: "blue" },
      { id: "g2", label: "Two", color: "green" },
    ],
    collapsedIds: [],
  });
  return table;
}
const ttRow = (table, id) =>
  table.element.querySelector(`.tt-row[data-id="${id}"]`);

test("dropping a dragged tunnel on any row of an expanded group assigns it there", () => {
  const calls = { assign: [] };
  const table = mountGroupedTable(calls);

  ttRow(table, "a").dispatchEvent(new Event("dragstart", { bubbles: true }));
  ttRow(table, "c").dispatchEvent(
    new Event("dragover", { bubbles: true, cancelable: true }),
  );
  assert.ok(
    ttRow(table, "b").classList.contains("tt-row--drop"),
    "sibling row in the target group is highlighted",
  );
  assert.ok(
    table.element
      .querySelector('.tt-group-row[data-section="g2"]')
      .classList.contains("tt-group-row--drop"),
    "the target group header row is highlighted",
  );

  ttRow(table, "c").dispatchEvent(
    new Event("drop", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(calls.assign, [["a", "g2"]], "'a' moved into g2");
  assert.equal(
    table.element.querySelectorAll(".tt-row--drop").length,
    0,
    "drop highlight cleared",
  );
});

test("dropping a tunnel on a row of its OWN group is a no-op", () => {
  const calls = { assign: [] };
  const table = mountGroupedTable(calls);
  ttRow(table, "b").dispatchEvent(new Event("dragstart", { bubbles: true }));
  ttRow(table, "c").dispatchEvent(
    new Event("dragover", { bubbles: true, cancelable: true }),
  );
  ttRow(table, "c").dispatchEvent(
    new Event("drop", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(calls.assign, [], "already in g2 → no re-assign");
});
