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

// console-list.test.js — the CONSOLES sidebar section: a row per console with a
// terminal glyph + session status lamp, selection on click, open on double-click /
// Enter, the add + context-menu callbacks, in-place lamp updates, and empty state.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { ConsoleList } from "../components/console-list.js";
import { t } from "../i18n.js";

function mount() {
  resetDom();
  const calls = { select: [], add: 0, open: [], context: [] };
  const list = new ConsoleList({
    onSelect: (id) => calls.select.push(id),
    onAdd: () => (calls.add += 1),
    onOpen: (id) => calls.open.push(id),
    onContextMenu: (id) => calls.context.push(id),
  });
  document.body.appendChild(list.element);
  return { list, calls };
}

const DEFS = [
  { id: "a", name: "db-prod" },
  { id: "b", name: "bastion" },
];
const rows = (list) => [...list.element.querySelectorAll(".tunnel-row")];

test("renders a row per console with the terminal glyph, name, and lamp", () => {
  const { list } = mount();
  list.setData(DEFS, new Map([["a", "connected"]]), null);
  const r = rows(list);
  assert.equal(r.length, 2);
  assert.equal(r[0].querySelector(".tunnel-row-name").textContent, "db-prod");
  assert.ok(r[0].querySelector(".tunnel-type-icon--console"), "terminal glyph");
  assert.ok(r[0].querySelector(".tunnel-signal--green"), "connected → green");
});

test("click selects; double-click and Enter open; Space selects", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map(), null);
  const r = rows(list);

  r[0].dispatchEvent(new Event("click", { bubbles: true }));
  assert.deepEqual(calls.select, ["a"]);

  r[1].dispatchEvent(new Event("dblclick", { bubbles: true }));
  assert.deepEqual(calls.open, ["b"]);

  r[0].dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
  );
  assert.deepEqual(calls.open, ["b", "a"]);

  r[1].dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  assert.deepEqual(calls.select, ["a", "b"]);
});

test("right-click reports the row for the native context menu", () => {
  const { list, calls } = mount();
  list.setData(DEFS, new Map(), null);
  rows(list)[1].dispatchEvent(
    new Event("contextmenu", { bubbles: true, cancelable: true }),
  );
  assert.deepEqual(calls.context, ["b"]);
});

test("the add button fires onAdd", () => {
  const { list, calls } = mount();
  list.element.querySelector(".tunnel-add-btn").click();
  assert.equal(calls.add, 1);
});

test("updateState relights the row's signal in place", () => {
  const { list } = mount();
  list.setData(DEFS, new Map(), null);
  const r = rows(list);
  assert.ok(!r[0].querySelector(".tunnel-signal--green"));
  list.updateState("a", "connected");
  assert.ok(r[0].querySelector(".tunnel-signal--green"));
  list.updateState("a", null); // no session → lamp off
  assert.ok(!r[0].querySelector(".tunnel-signal--green"));
});

test("shows the empty state when there are no consoles", () => {
  const { list } = mount();
  list.setData([], new Map(), null);
  assert.equal(rows(list).length, 0);
  const empty = list.element.querySelector(".tunnel-list-empty");
  assert.ok(!empty.hidden);
  assert.equal(
    empty.querySelector(".tunnel-list-empty-title").textContent,
    t("consoles.empty"),
  );
});
