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

import { resetDom, typeInto, change } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JumpHostEditorDialog } from "../components/jump-host-editor-dialog.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function stub(calls = {}) {
  return {
    jumpHosts: {
      create: async (p) => ((calls.create ||= []).push(p), { id: "j9", ...p }),
      update: async (id, p) => (
        (calls.update ||= []).push({ id, p }),
        { id, ...p }
      ),
    },
    credentials: { list: async () => [{ id: "c1", label: "Prod" }] },
  };
}

function mount(calls = {}, onSaved) {
  resetDom();
  return new JumpHostEditorDialog({ jumphippo: stub(calls), onSaved });
}

const q = (dlg, s) => dlg.element.querySelector(s);

test("openCreate renders host/port + a credential picker, defaulting port 22", async () => {
  const dlg = mount();
  await dlg.openCreate();
  assert.ok(dlg.element.open);
  assert.ok(q(dlg, ".cred-picker-select"), "embeds a credential picker");
  assert.equal(q(dlg, '[aria-label="Port"]').value, "22");
});

test("a valid create persists, closes and emits jumphosts-changed", async () => {
  const calls = {};
  const changed = [];
  const dlg = mount(calls);
  window.addEventListener("jumphippo:jumphosts-changed", (e) =>
    changed.push(e.detail),
  );
  await dlg.openCreate();

  typeInto(q(dlg, '[aria-label="Name"]'), "Corp bastion");
  typeInto(q(dlg, '[aria-label="Host"]'), "bastion.corp");
  change(q(dlg, ".cred-picker-select"), "c1");

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();

  assert.deepEqual(calls.create[0], {
    label: "Corp bastion",
    host: "bastion.corp",
    port: 22,
    credentialId: "c1",
  });
  assert.ok(!dlg.element.open);
  assert.deepEqual(changed[0], { id: "j9" });
});

test("openEdit prefills the form and a save updates that record", async () => {
  const calls = {};
  const changed = [];
  const saved = [];
  const dlg = mount(calls, (r) => saved.push(r));
  window.addEventListener("jumphippo:jumphosts-changed", (e) =>
    changed.push(e.detail),
  );
  await dlg.openEdit({
    id: "j5",
    label: "Corp bastion",
    host: "bastion.corp",
    port: 2222,
    credentialId: "c1",
  });

  assert.ok(dlg.element.open);
  assert.equal(q(dlg, '[aria-label="Name"]').value, "Corp bastion");
  assert.equal(q(dlg, '[aria-label="Host"]').value, "bastion.corp");
  assert.equal(q(dlg, '[aria-label="Port"]').value, "2222");

  typeInto(q(dlg, '[aria-label="Host"]'), "bastion2.corp");
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();

  assert.equal(calls.create, undefined, "edit must not create");
  assert.deepEqual(calls.update[0], {
    id: "j5",
    p: {
      label: "Corp bastion",
      host: "bastion2.corp",
      port: 2222,
      credentialId: "c1",
    },
  });
  assert.ok(!dlg.element.open);
  assert.deepEqual(changed[0], { id: "j5" });
  assert.equal(saved[0].id, "j5");
});

test("a jump host with no credential shows a field error and doesn't persist", async () => {
  const calls = {};
  const dlg = mount(calls);
  await dlg.openCreate();
  typeInto(q(dlg, '[aria-label="Name"]'), "b");
  typeInto(q(dlg, '[aria-label="Host"]'), "h");
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.create, undefined);
  assert.ok(
    dlg.element
      .querySelector('.field[data-error-key="credentialId"]')
      .classList.contains("field--error"),
  );
});
