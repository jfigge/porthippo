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

// tunnel-list.test.js — the sidebar master list: status-dot colour by state, the
// port + name, selection, the add/edit callbacks (and that edit doesn't also
// select), that delete is no longer an inline icon, and in-place dot updates.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { TunnelList, dotState } from "../components/tunnel-list.js";

function mount() {
  resetDom();
  const calls = { select: [], add: 0, edit: [], context: [] };
  const list = new TunnelList({
    onSelect: (id) => calls.select.push(id),
    onAdd: () => (calls.add += 1),
    onEdit: (id) => calls.edit.push(id),
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

test("renders a row per definition with dot, port and name", () => {
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
  assert.equal(r[0].querySelector(".tunnel-row-port").textContent, "5432");
  assert.equal(r[0].querySelector(".tunnel-row-name").textContent, "Postgres");
  assert.ok(r[0].querySelector(".tunnel-dot--armed"), "connected → green dot");
  assert.ok(r[1].querySelector(".tunnel-dot--disarmed"), "disarmed → grey dot");
});

test("empty state shows when there are no tunnels", () => {
  const { list } = mount();
  list.setData([], new Map());
  assert.equal(list.element.querySelector(".tunnel-list-empty").hidden, false);
  assert.equal(list.element.querySelector(".tunnel-list").hidden, true);
});

test("clicking a row selects it; edit acts without selecting", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map());
  const r = rows(list);

  r[1].click();
  assert.deepEqual(calls.select, ["b"]);

  r[0].querySelector(".tunnel-edit-btn").click();
  assert.deepEqual(calls.edit, ["a"]);
  // The edit click did NOT also fire selection.
  assert.deepEqual(calls.select, ["b"], "edit stops propagation");
});

test("delete is no longer an inline row icon (it lives on the context menu)", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map());
  const r = rows(list);
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

test("updateState recolours a single row's dot in place", () => {
  const { list } = mount();
  list.setData(DEFS, new Map([["a", "disarmed"]]));
  const dot = rows(list)[0].querySelector(".tunnel-dot");
  assert.ok(dot.classList.contains("tunnel-dot--disarmed"));

  list.updateState("a", "error");
  const dotAfter = rows(list)[0].querySelector(".tunnel-dot");
  assert.ok(dotAfter.classList.contains("tunnel-dot--error"));
  assert.equal(dotAfter, dot, "updated in place, not rebuilt");
});
