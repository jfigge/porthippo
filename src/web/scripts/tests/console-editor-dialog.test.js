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

// console-editor-dialog.test.js — create/edit a console: the Target-server field
// parses into sshHost[:sshPort], a valid create persists + emits consoles-changed,
// openEdit prefills (dropping the default :22), and an empty target blocks the save.

import { resetDom, typeInto, change } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConsoleEditorDialog } from "../components/console-editor-dialog.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};

function stub(calls = {}) {
  return {
    consoles: {
      create: async (p) => ((calls.create ||= []).push(p), { id: "k9", ...p }),
      update: async (id, p) => (
        (calls.update ||= []).push({ id, p }),
        { id, ...p }
      ),
    },
    credentials: {
      list: async () => [{ id: "c1", label: "Prod" }],
      get: async (id) => ({ id, label: "Prod" }),
    },
    jumpHosts: { list: async () => [] },
  };
}

function mount(calls = {}, onSaved) {
  resetDom();
  return new ConsoleEditorDialog({ jumphippo: stub(calls), onSaved });
}

const q = (dlg, s) => dlg.element.querySelector(s);

test("openCreate renders a name + target field and a credential picker", async () => {
  const dlg = mount();
  dlg.openCreate();
  await settle();
  assert.ok(dlg.element.open);
  assert.ok(q(dlg, ".cred-picker-select"), "embeds a credential picker");
  assert.ok(q(dlg, '[aria-label="Name"]'), "a name field");
  assert.ok(q(dlg, '[aria-label="Target server"]'), "a target field");
});

test("a valid create parses the target and persists", async () => {
  const calls = {};
  const changed = [];
  const dlg = mount(calls);
  window.addEventListener("jumphippo:consoles-changed", (e) =>
    changed.push(e.detail),
  );
  dlg.openCreate();
  await settle();

  typeInto(q(dlg, '[aria-label="Name"]'), "db shell");
  typeInto(q(dlg, '[aria-label="Target server"]'), "db.internal:2222");
  change(q(dlg, ".cred-picker-select"), "c1");

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();

  assert.deepEqual(calls.create[0], {
    name: "db shell",
    credentialId: "c1",
    jumpHostIds: [],
    sshHost: "db.internal",
    sshPort: 2222,
  });
  assert.ok(!dlg.element.open);
  assert.deepEqual(changed[0], { id: "k9" });
});

test("openEdit prefills name + target (dropping :22) and updates", async () => {
  const calls = {};
  const dlg = mount(calls);
  dlg.openEdit({
    id: "k5",
    name: "db shell",
    sshHost: "db.internal",
    sshPort: 22,
    credentialId: "c1",
    jumpHostIds: [],
  });
  await settle();

  assert.equal(q(dlg, '[aria-label="Name"]').value, "db shell");
  assert.equal(q(dlg, '[aria-label="Target server"]').value, "db.internal");

  typeInto(q(dlg, '[aria-label="Target server"]'), "db2.internal:2200");
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();

  assert.equal(calls.create, undefined, "edit must not create");
  assert.deepEqual(calls.update[0], {
    id: "k5",
    p: {
      name: "db shell",
      credentialId: "c1",
      jumpHostIds: [],
      sshHost: "db2.internal",
      sshPort: 2200,
    },
  });
});

test("an empty target blocks the save", async () => {
  const calls = {};
  const dlg = mount(calls);
  dlg.openCreate();
  await settle();

  typeInto(q(dlg, '[aria-label="Name"]'), "x");
  change(q(dlg, ".cred-picker-select"), "c1");
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();

  assert.equal(calls.create, undefined, "no create on a validation error");
  assert.ok(dlg.element.open, "stays open on a validation error");
});
