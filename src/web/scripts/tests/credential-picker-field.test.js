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
import { CredentialPickerField } from "../components/credential-picker-field.js";
import { PopupManager } from "../popup-manager.js";
import { t } from "../i18n.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

function stub(creds, deleteImpl) {
  const list = [...creds];
  return {
    credentials: {
      list: async () => list,
      get: async (id) => list.find((c) => c.id === id) || null,
      create: async (p) => {
        const rec = { id: "cN", ...p };
        list.push(rec);
        return rec;
      },
      delete:
        deleteImpl ||
        (async (id) => {
          const i = list.findIndex((c) => c.id === id);
          if (i !== -1) list.splice(i, 1);
          return { id };
        }),
    },
    _list: list,
  };
}

async function mount(
  creds = [{ id: "c1", label: "Prod" }],
  onChange,
  opts = {},
) {
  resetDom();
  const jumphippo = stub(creds, opts.deleteImpl);
  const picker = new CredentialPickerField({ jumphippo, onChange });
  document.body.appendChild(picker.element);
  await picker.load();
  return { picker, jumphippo };
}

const sel = (p) => p.element.querySelector(".cred-picker-select");
const deleteBtn = (p) => p.element.querySelector(".cred-picker-delete");

test("renders a placeholder + one option per credential", async () => {
  const { picker } = await mount([
    { id: "c1", label: "Prod" },
    { id: "c2", label: "Staging" },
  ]);
  const options = sel(picker).querySelectorAll("option");
  assert.equal(options.length, 3); // placeholder + 2
  assert.equal(options[1].value, "c1");
  assert.equal(options[1].textContent, "Prod");
});

test("choosing an option reports the id and enables Edit", async () => {
  const picked = [];
  const { picker } = await mount([{ id: "c1", label: "Prod" }], (id) =>
    picked.push(id),
  );
  assert.equal(
    picker.element.querySelector(".cred-picker-edit").disabled,
    true,
    "Edit disabled with no selection",
  );
  change(sel(picker), "c1");
  assert.deepEqual(picked, ["c1"]);
  assert.equal(picker.value, "c1");
  assert.equal(
    picker.element.querySelector(".cred-picker-edit").disabled,
    false,
  );
});

test("setValue selects, and a deleted selection falls back to none", async () => {
  const { picker } = await mount([{ id: "c1", label: "Prod" }]);
  picker.setValue("c1");
  assert.equal(picker.value, "c1");
  picker.setValue("gone");
  assert.equal(picker.value, "", "a missing id resets to the placeholder");
});

test("a credentials-changed event refreshes the options", async () => {
  const { picker, jumphippo } = await mount([{ id: "c1", label: "Prod" }]);
  jumphippo._list.push({ id: "c2", label: "New one" });
  window.dispatchEvent(new CustomEvent("jumphippo:credentials-changed"));
  await flush();
  assert.equal(sel(picker).querySelectorAll("option").length, 3);
});

test("New… opens the credential editor dialog", async () => {
  const { picker } = await mount([]);
  picker.element.querySelector(".cred-picker-new").click();
  const dialog = document.querySelector(".credential-dialog");
  assert.ok(dialog && dialog.open, "credential editor opened");
});

test("the picker-row actions are icon buttons with accessible labels", async () => {
  const { picker } = await mount([{ id: "c1", label: "Prod" }]);
  for (const [cls, label] of [
    [".cred-picker-new", t("cred.new")],
    [".cred-picker-edit", t("common.edit")],
    [".cred-picker-delete", t("cred.delete")],
  ]) {
    const btn = picker.element.querySelector(cls);
    assert.ok(btn, `${cls} present`);
    assert.ok(btn.classList.contains("btn--icon"), `${cls} is an icon button`);
    assert.equal(btn.getAttribute("aria-label"), label, `${cls} labelled`);
    assert.ok(btn.querySelector("svg"), `${cls} renders an SVG glyph`);
  }
});

test("Delete is disabled until a credential is selected", async () => {
  const { picker } = await mount([{ id: "c1", label: "Prod" }]);
  assert.equal(deleteBtn(picker).disabled, true);
  change(sel(picker), "c1");
  assert.equal(deleteBtn(picker).disabled, false);
});

test("Delete confirms then removes the selected credential record", async () => {
  const { picker, jumphippo } = await mount([{ id: "c1", label: "Prod" }]);
  const changed = [];
  const onChanged = () => changed.push(1);
  window.addEventListener("jumphippo:credentials-changed", onChanged);
  try {
    change(sel(picker), "c1");
    deleteBtn(picker).click();

    const danger = document.querySelector(".popup-confirm .btn--danger");
    assert.ok(danger, "the delete confirm opened");
    assert.equal(danger.disabled, false, "no type-to-confirm gate");
    danger.click();
    await settle();

    assert.equal(
      jumphippo._list.find((c) => c.id === "c1"),
      undefined,
      "the record was deleted",
    );
    assert.equal(picker.value, "", "and cleared from the selection");
    assert.ok(changed.length >= 1, "announced credentials-changed");
  } finally {
    window.removeEventListener("jumphippo:credentials-changed", onChanged);
    PopupManager.close();
  }
});

test("Delete blocked while in use shows a notice and keeps the credential", async () => {
  const inUse = async () => ({ __hippoError: true, code: "IN_USE" });
  const { picker, jumphippo } = await mount(
    [{ id: "c1", label: "Prod" }],
    null,
    { deleteImpl: inUse },
  );
  change(sel(picker), "c1");
  deleteBtn(picker).click();
  document.querySelector(".popup-confirm .btn--danger").click();
  await settle();

  const notify = document.querySelector(".popup-notify .popup-message");
  assert.ok(notify, "an in-use notice is shown");
  assert.equal(notify.textContent, t("cred.delete.inUse"));
  assert.ok(
    jumphippo._list.find((c) => c.id === "c1"),
    "the credential is kept",
  );
  PopupManager.close();
});
