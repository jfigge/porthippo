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

import { resetDom, change } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JumpHostPickerField } from "../components/jump-host-picker-field.js";
import { PopupManager } from "../popup-manager.js";
import { t } from "../i18n.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
// The delete flow chains async hops (confirm → jumpHosts.delete → change event →
// refresh → re-render); drain a few ticks so all settle.
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

function stub(jumps, deleteImpl) {
  const list = [...jumps];
  return {
    jumpHosts: {
      list: async () => list,
      get: async (id) => list.find((j) => j.id === id) || null,
      delete:
        deleteImpl ||
        (async (id) => {
          const i = list.findIndex((j) => j.id === id);
          if (i !== -1) list.splice(i, 1);
          return { id };
        }),
    },
    credentials: { list: async () => [] },
    _list: list,
  };
}

async function mount(jumps, onChange, deleteImpl) {
  resetDom();
  const jumphippo = stub(
    jumps || [
      { id: "j1", label: "relay1", host: "r1", port: 22 },
      { id: "j2", label: "relay2", host: "r2", port: 22 },
    ],
    deleteImpl,
  );
  const picker = new JumpHostPickerField({ jumphippo, onChange });
  document.body.appendChild(picker.element);
  await picker.load();
  return { picker, jumphippo };
}

const addSelect = (p) => p.element.querySelector(".jumps-add-select");
const addBtn = (p) => p.element.querySelector(".jumps-add-btn");
const editBtn = (p) => p.element.querySelector(".jumps-edit-btn");
const deleteBtn = (p) => p.element.querySelector(".jumps-delete-btn");
const rows = (p) => p.element.querySelectorAll(".jumps-chain-row");

test("an empty chain shows the direct-connection hint", async () => {
  const { picker } = await mount();
  assert.equal(picker.element.querySelector(".jumps-empty").hidden, false);
  assert.equal(rows(picker).length, 0);
});

test("choosing a jump host focuses it without touching the chain", async () => {
  const emitted = [];
  const { picker } = await mount(undefined, (ids) => emitted.push(ids));
  change(addSelect(picker), "j1");
  assert.deepEqual(picker.value, []);
  assert.deepEqual(emitted, []);
  assert.equal(rows(picker).length, 0);
  // Focusing enables Add + Edit for that host.
  assert.equal(addBtn(picker).disabled, false);
  assert.equal(editBtn(picker).disabled, false);
});

test("Add appends the focused jump host and reports the chain", async () => {
  const emitted = [];
  const { picker } = await mount(undefined, (ids) => emitted.push(ids));
  change(addSelect(picker), "j1");
  addBtn(picker).click();
  assert.deepEqual(picker.value, ["j1"]);
  assert.deepEqual(emitted.at(-1), ["j1"]);
  assert.equal(rows(picker).length, 1);
  // The picker still lists every host, but Add is now disabled for the chosen one.
  const optionValues = [...addSelect(picker).querySelectorAll("option")].map(
    (o) => o.value,
  );
  assert.deepEqual(optionValues, ["", "j1", "j2"]);
  assert.equal(addBtn(picker).disabled, true);
});

test("reorder + remove keep the chain in sync", async () => {
  const { picker } = await mount();
  picker.setValue(["j1", "j2"]);
  // Move the second up.
  picker.element
    .querySelectorAll(".jumps-chain-row")[1]
    .querySelector('[aria-label="Move up"]')
    .click();
  assert.deepEqual(picker.value, ["j2", "j1"]);
  // Remove the first.
  picker.element
    .querySelector(".jumps-chain-row")
    .querySelector('[aria-label="Remove jump host"]')
    .click();
  assert.deepEqual(picker.value, ["j1"]);
});

test("refresh prunes a chain entry whose jump host was deleted", async () => {
  const emitted = [];
  const { picker, jumphippo } = await mount(undefined, (ids) =>
    emitted.push(ids),
  );
  picker.setValue(["j1", "j2"]);
  jumphippo._list.splice(0, 1); // delete j1
  window.dispatchEvent(new CustomEvent("jumphippo:jumphosts-changed"));
  await flush();
  assert.deepEqual(picker.value, ["j2"]);
});

test("New… opens the jump-host editor dialog", async () => {
  const { picker } = await mount();
  picker.element.querySelector(".jumps-new-btn").click();
  await flush();
  const dialog = document.querySelector(".jump-host-dialog");
  assert.ok(dialog && dialog.open);
});

test("Edit is disabled until a jump host is focused", async () => {
  const { picker } = await mount();
  assert.equal(editBtn(picker).disabled, true);
  change(addSelect(picker), "j1");
  assert.equal(editBtn(picker).disabled, false);
});

test("Edit opens the editor for the focused host without adding it", async () => {
  const { picker } = await mount();
  change(addSelect(picker), "j1");
  editBtn(picker).click();
  await flush();
  const dialog = document.querySelector(".jump-host-dialog");
  assert.ok(dialog && dialog.open);
  // Editing a host that isn't in the chain must not add it.
  assert.deepEqual(picker.value, []);
});

test("the picker-row actions are icon buttons with accessible labels", async () => {
  const { picker } = await mount();
  for (const [sel, label] of [
    [".jumps-add-btn", t("jumps.add")],
    [".jumps-new-btn", t("jumps.new")],
    [".jumps-edit-btn", t("common.edit")],
    [".jumps-delete-btn", t("jumps.delete")],
  ]) {
    const btn = picker.element.querySelector(sel);
    assert.ok(btn, `${sel} present`);
    assert.ok(btn.classList.contains("btn--icon"), `${sel} is an icon button`);
    assert.equal(btn.getAttribute("aria-label"), label, `${sel} labelled`);
    assert.ok(btn.querySelector("svg"), `${sel} renders an SVG glyph`);
  }
});

test("Delete is disabled until a jump host is focused", async () => {
  const { picker } = await mount();
  assert.equal(deleteBtn(picker).disabled, true);
  change(addSelect(picker), "j1");
  assert.equal(deleteBtn(picker).disabled, false);
});

test("Delete confirms then removes the focused jump-host record (and prunes the chain)", async () => {
  const { picker, jumphippo } = await mount();
  const changed = [];
  const onChanged = () => changed.push(1);
  window.addEventListener("jumphippo:jumphosts-changed", onChanged);
  try {
    picker.setValue(["j1"]);
    change(addSelect(picker), "j1");
    deleteBtn(picker).click();

    const danger = document.querySelector(".popup-confirm .btn--danger");
    assert.ok(danger, "the delete confirm opened");
    assert.equal(danger.disabled, false, "no type-to-confirm gate for a host");
    danger.click();
    await settle();

    assert.equal(
      jumphippo._list.find((j) => j.id === "j1"),
      undefined,
      "the record was deleted",
    );
    assert.deepEqual(picker.value, [], "and pruned from the chain");
    assert.ok(changed.length >= 1, "announced jumphosts-changed");
  } finally {
    window.removeEventListener("jumphippo:jumphosts-changed", onChanged);
    PopupManager.close();
  }
});

test("Delete blocked while in use shows a notice and keeps the host", async () => {
  const inUse = async () => ({ __hippoError: true, code: "IN_USE" });
  const { picker, jumphippo } = await mount(undefined, undefined, inUse);
  change(addSelect(picker), "j1");
  deleteBtn(picker).click();
  document.querySelector(".popup-confirm .btn--danger").click();
  await settle();

  const notify = document.querySelector(".popup-notify .popup-message");
  assert.ok(notify, "an in-use notice is shown");
  assert.equal(notify.textContent, t("jumps.delete.inUse"));
  assert.ok(
    jumphippo._list.find((j) => j.id === "j1"),
    "the host is kept (not deleted)",
  );
  PopupManager.close();
});
