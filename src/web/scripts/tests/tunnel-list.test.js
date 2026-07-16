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

// tunnel-list.test.js — the sidebar master list: the three-lamp status signal by
// state, the port + name, selection, the add/edit callbacks (and that edit doesn't
// also select), that delete is no longer an inline icon, and in-place signal updates.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { TunnelList, dotState, signalLamp } from "../components/tunnel-list.js";
import { t } from "../i18n.js";

function mount() {
  resetDom();
  const calls = { select: [], add: 0, context: [] };
  const list = new TunnelList({
    onSelect: (id) => calls.select.push(id),
    onAdd: () => (calls.add += 1),
    onContextMenu: (id) => calls.context.push(id),
  });
  document.body.appendChild(list.element);
  return { list, calls };
}

const DEFS = [
  { id: "a", localPort: 5432, name: "Postgres" },
  { id: "b", localPort: 6379, name: "Redis" },
];
const rows = (list) => [...list.element.querySelectorAll(".tunnel-row")];

test("dotState maps live states to the four buckets", () => {
  assert.equal(dotState("disarmed"), "disarmed");
  assert.equal(dotState("listening"), "armed");
  assert.equal(dotState("connecting"), "armed");
  assert.equal(dotState("connected"), "armed");
  assert.equal(dotState("paused"), "paused");
  assert.equal(dotState("error"), "error");
});

test("signalLamp maps live states to the lit traffic-light lamp", () => {
  assert.equal(signalLamp("disarmed"), "off");
  assert.equal(signalLamp(undefined), "off");
  assert.equal(signalLamp("listening"), "amber");
  assert.equal(signalLamp("connecting"), "amber");
  assert.equal(signalLamp("paused"), "amber");
  assert.equal(signalLamp("connected"), "green");
  assert.equal(signalLamp("error"), "red");
});

test("renders a row per definition with signal and name", () => {
  const { list } = mount();
  list.setData(
    DEFS,
    new Map([
      ["a", "connected"],
      ["b", "disarmed"],
    ]),
  );
  const r = rows(list);
  assert.equal(r.length, 2);
  assert.equal(r[0].querySelector(".tunnel-row-port"), null);
  assert.equal(r[0].querySelector(".tunnel-row-name").textContent, "Postgres");
  assert.ok(
    r[0].querySelector(".tunnel-signal--green"),
    "connected → green lamp",
  );
  const bSignal = r[1].querySelector(".tunnel-signal");
  assert.ok(bSignal, "disarmed row still has a signal");
  assert.ok(
    !bSignal.matches(
      ".tunnel-signal--red, .tunnel-signal--amber, .tunnel-signal--green",
    ),
    "disarmed → no lamp lit",
  );
});

test("every row shows a forwarding-type icon; the type drives the glyph + label", () => {
  const { list } = mount();
  list.setData(
    [
      { id: "a", name: "Local one" }, // no type → local (no longer blank)
      { id: "b", name: "Reverse", type: "remote" },
      { id: "c", name: "Proxy", type: "dynamic" },
    ],
    new Map(),
  );
  const r = rows(list);
  const icon = (row) => row.querySelector(".tunnel-type-icon");

  assert.ok(
    icon(r[0]),
    "local row is badged (the common case is no longer blank)",
  );
  assert.ok(icon(r[0]).classList.contains("tunnel-type-icon--local"));
  assert.ok(icon(r[0]).querySelector("svg"), "the glyph is an inline SVG");
  assert.equal(icon(r[0]).getAttribute("aria-label"), t("editor.type.local"));

  assert.ok(icon(r[1]).classList.contains("tunnel-type-icon--remote"));
  assert.equal(icon(r[1]).getAttribute("title"), t("editor.type.remote"));

  assert.ok(icon(r[2]).classList.contains("tunnel-type-icon--dynamic"));
  assert.equal(icon(r[2]).getAttribute("aria-label"), t("editor.type.dynamic"));
});

test("empty state shows when there are no tunnels", () => {
  const { list } = mount();
  list.setData([], new Map());
  assert.equal(list.element.querySelector(".tunnel-list-empty").hidden, false);
  assert.equal(list.element.querySelector(".tunnel-list").hidden, true);
});

test("clicking a row selects it", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map());
  const r = rows(list);

  r[1].click();
  assert.deepEqual(calls.select, ["b"]);
});

test("edit and delete are no longer inline row icons (they live on the context menu)", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map());
  const r = rows(list);
  assert.equal(r[0].querySelector(".tunnel-edit-btn"), null, "no edit icon");
  assert.equal(
    r[0].querySelector(".tunnel-delete-btn"),
    null,
    "no delete icon",
  );

  // The row still surfaces its actions via a native context-menu request.
  r[0].dispatchEvent(
    new Event("contextmenu", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(calls.context, ["a"]);
});

test("the header add button fires onAdd", () => {
  const { list, calls } = mount();
  list.element.querySelector(".tunnel-add-btn").click();
  assert.equal(calls.add, 1);
});

test("setSelected highlights exactly one row", () => {
  const { list } = mount();
  list.setData(DEFS, new Map());
  list.setSelected("b");
  const r = rows(list);
  assert.ok(!r[0].classList.contains("tunnel-row--selected"));
  assert.ok(r[1].classList.contains("tunnel-row--selected"));
  assert.equal(r[1].getAttribute("aria-selected"), "true");
});

test("updateState relights a single row's signal in place", () => {
  const { list } = mount();
  list.setData(DEFS, new Map([["a", "disarmed"]]));
  const signal = rows(list)[0].querySelector(".tunnel-signal");
  assert.ok(
    !signal.matches(
      ".tunnel-signal--red, .tunnel-signal--amber, .tunnel-signal--green",
    ),
    "disarmed → no lamp lit",
  );

  list.updateState("a", "error");
  const signalAfter = rows(list)[0].querySelector(".tunnel-signal");
  assert.ok(signalAfter.classList.contains("tunnel-signal--red"));
  assert.equal(signalAfter, signal, "updated in place, not rebuilt");
});

// ── Grouping (Feature 140) ───────────────────────────────────────────────────

const headers = (list) => [...list.element.querySelectorAll(".group-header")];

test("with no groups the list stays flat (no group headers)", () => {
  const { list } = mount();
  list.setData(DEFS, new Map());
  list.setGrouping({ groups: [], collapsedIds: [] });
  assert.equal(headers(list).length, 0);
  assert.equal(rows(list).length, 2);
});

test("renders a section per group plus an implicit Ungrouped section", () => {
  const { list } = mount();
  list.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B" }, // ungrouped
    ],
    new Map(),
  );
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const h = headers(list);
  assert.equal(h.length, 2, "Work + Ungrouped");
  assert.equal(h[0].querySelector(".group-name").textContent, "Work");
  assert.equal(h[0].querySelector(".group-count").textContent, "0/1");
  assert.equal(rows(list).length, 2);
});

test("rows in a section carry a data-section hook (tree indent); flat rows don't", () => {
  const { list } = mount();
  // No groups → a flat list, rows are not nested (no hook).
  list.setData(DEFS, new Map());
  list.setGrouping({ groups: [], collapsedIds: [] });
  assert.equal(rows(list)[0].dataset.section, undefined);

  // Grouped → each row is tagged with its section id (grouped + implicit Ungrouped).
  list.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B" }, // ungrouped
    ],
    new Map(),
  );
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  assert.equal(listRow(list, "a").dataset.section, "g1");
  assert.equal(listRow(list, "b").dataset.section, "__ungrouped");
});

test("a collapsed section hides its rows but keeps its header", () => {
  const { list } = mount();
  list.setData([{ id: "a", name: "A", groupId: "g1" }], new Map());
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: ["g1"],
  });
  assert.equal(headers(list).length, 1);
  assert.equal(list.element.querySelector('.tunnel-row[data-id="a"]'), null);
});

test("the group header arm switch fires an action; clicking the header collapses", () => {
  const calls = { action: [], collapse: [] };
  const list = new TunnelList({
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: (sid) => calls.collapse.push(sid),
  });
  document.body.appendChild(list.element);
  list.setData([{ id: "a", name: "A", groupId: "g1" }], new Map()); // disarmed
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const header = list.element.querySelector('.group-header[data-section="g1"]');
  header
    .querySelector(".group-arm-switch")
    .dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(calls.action, [["g1", "arm"]], "all disarmed → arm all");
  header.click();
  assert.deepEqual(calls.collapse, ["g1"]);
});

test("the group arm switch reads live state, not a stale header snapshot", () => {
  const calls = { action: [] };
  const list = new TunnelList({
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(list.element);
  list.setData([{ id: "a", name: "A", groupId: "g1" }], new Map()); // disarmed
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const sw = list.element
    .querySelector('.group-header[data-section="g1"]')
    .querySelector(".group-arm-switch");
  sw.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(calls.action, [["g1", "arm"]], "all disarmed → arm all");
  // A live broadcast arms the tunnel (in-place refresh, no full re-render).
  list.updateState("a", "connected");
  sw.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(
    calls.action[1],
    ["g1", "disarm"],
    "now fully armed → disarm all (not a stale re-arm)",
  );
});

test("the group header has a pause/resume icon acting on the whole group", () => {
  const calls = { action: [] };
  const list = new TunnelList({
    onGroupAction: (sid, action) => calls.action.push([sid, action]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(list.element);
  list.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B", groupId: "g1" },
    ],
    new Map([
      ["a", "connected"],
      ["b", "disarmed"],
    ]),
  );
  list.setGrouping({
    groups: [{ id: "g1", label: "Work", color: "blue" }],
    collapsedIds: [],
  });
  const btn = () =>
    list.element
      .querySelector('.group-header[data-section="g1"]')
      .querySelector(".group-pause-btn");
  assert.ok(btn(), "the pause icon renders");
  assert.equal(btn().disabled, false, "enabled while a tunnel is connected");
  assert.equal(btn().getAttribute("aria-label"), t("group.pauseAll"));
  btn().click();
  assert.deepEqual(calls.action, [["g1", "pause"]], "connected → pause all");

  // Every still-active tunnel paused → the icon flips to resume.
  list.updateState("a", "paused");
  assert.equal(btn().getAttribute("aria-label"), t("group.resumeAll"));
  btn().click();
  assert.deepEqual(
    calls.action[1],
    ["g1", "resume"],
    "all paused → resume all",
  );

  // Nothing pausable/resumable → disabled, and a click is a no-op.
  list.updateState("a", "disarmed");
  assert.equal(btn().disabled, true, "disabled when nothing is pausable");
  btn().click();
  assert.equal(calls.action.length, 2, "a disabled click does nothing");
});

function mountGrouped(calls) {
  const list = new TunnelList({
    onMoveTunnel: (id, groupId, beforeId) =>
      calls.move.push([id, groupId, beforeId]),
    onToggleCollapse: () => {},
  });
  document.body.appendChild(list.element);
  list.setData(
    [
      { id: "a", name: "A", groupId: "g1" },
      { id: "b", name: "B", groupId: "g2" },
      { id: "c", name: "C", groupId: "g2" },
    ],
    new Map(),
  );
  list.setGrouping({
    groups: [
      { id: "g1", label: "One", color: "blue" },
      { id: "g2", label: "Two", color: "green" },
    ],
    collapsedIds: [],
  });
  return list;
}
const listRow = (list, id) =>
  list.element.querySelector(`.tunnel-row[data-id="${id}"]`);
const dragEvt = (type) => new Event(type, { bubbles: true, cancelable: true });

test("dragging a tunnel over a row inserts a blank gap and moves it there on drop", () => {
  const calls = { move: [] };
  const list = mountGrouped(calls);

  listRow(list, "a").dispatchEvent(dragEvt("dragstart"));
  // Drag over a ROW in the other group (with no layout, the gap lands before it).
  listRow(list, "c").dispatchEvent(dragEvt("dragover"));

  // A blank entry (placeholder) is shown, and the whole target section lights up.
  assert.ok(
    list.element.querySelector(".tunnel-row-placeholder"),
    "a blank gap is shown at the drop position",
  );
  assert.ok(
    listRow(list, "b").classList.contains("tunnel-row--drop"),
    "the whole target group is highlighted, not just the hovered row",
  );
  // The item's own slot is collapsed while the gap stands in for it.
  assert.ok(
    listRow(list, "a").classList.contains("tunnel-row--dragging"),
    "the dragged row's original space is hidden",
  );

  listRow(list, "c").dispatchEvent(dragEvt("drop"));
  // Moved into g2, sequenced before 'c'.
  assert.deepEqual(calls.move, [["a", "g2", "c"]]);
  // The gap + highlight are cleared and the row is restored after the drop.
  assert.equal(list.element.querySelector(".tunnel-row-placeholder"), null);
  assert.equal(list.element.querySelectorAll(".tunnel-row--drop").length, 0);
  assert.ok(!listRow(list, "a").classList.contains("tunnel-row--dragging"));
});

test("dropping over a group header sequences the tunnel at the top of that group", () => {
  const calls = { move: [] };
  const list = mountGrouped(calls);
  listRow(list, "a").dispatchEvent(dragEvt("dragstart"));
  list.element
    .querySelector('.group-header[data-section="g2"]')
    .dispatchEvent(dragEvt("dragover"));
  list.element
    .querySelector('.group-header[data-section="g2"]')
    .dispatchEvent(dragEvt("drop"));
  // Gap at the top of g2 → insert before its first member 'b'.
  assert.deepEqual(calls.move, [["a", "g2", "b"]]);
});

test("dragging off any group clears the gap and cancels the drop", () => {
  const calls = { move: [] };
  const list = mountGrouped(calls);
  listRow(list, "a").dispatchEvent(dragEvt("dragstart"));
  listRow(list, "c").dispatchEvent(dragEvt("dragover")); // over a group first
  assert.ok(list.element.querySelector(".tunnel-row-placeholder"));
  assert.ok(listRow(list, "a").classList.contains("tunnel-row--dragging"));

  // Now over the empty list container (not a row/header) → cancel.
  list.element.querySelector(".tunnel-list").dispatchEvent(dragEvt("dragover"));
  assert.equal(
    list.element.querySelector(".tunnel-row-placeholder"),
    null,
    "the gap is removed off any group",
  );
  // With no gap, the item's original space is shown again.
  assert.ok(
    !listRow(list, "a").classList.contains("tunnel-row--dragging"),
    "the dragged row is restored when off any group",
  );
  list.element.querySelector(".tunnel-list").dispatchEvent(dragEvt("drop"));
  assert.deepEqual(calls.move, [], "a drop off any group is cancelled");
});
