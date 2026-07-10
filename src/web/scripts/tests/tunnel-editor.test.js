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
import { TunnelEditor } from "../components/tunnel-editor.js";

function mount(opts = {}) {
  resetDom();
  const editor = new TunnelEditor(opts);
  document.body.appendChild(editor.element);
  return editor;
}

const setInput = (editor, key, value) =>
  typeInto(editor.element.querySelector(`.editor-input-${key}`), value);

/** Fill a complete, valid definition (agent auth on the SSH server). */
function fillValid(editor) {
  setInput(editor, "name", "Prod DB");
  setInput(editor, "localPort", "5432");
  setInput(editor, "destHost", "db.internal");
  setInput(editor, "destPort", "5432");
  const ssh = editor.element.querySelector(".hop-editor");
  typeInto(ssh.querySelector(".hop-input-host"), "ssh.example.com");
  typeInto(ssh.querySelector(".hop-input-port"), "22");
  typeInto(ssh.querySelector(".hop-input-user"), "deploy");
}

const submit = (editor) =>
  editor.element.dispatchEvent(new Event("submit", { cancelable: true }));

test("renders the core fields", () => {
  const editor = mount();
  for (const key of ["name", "localPort", "bindHost", "destHost", "destPort"]) {
    assert.ok(
      editor.element.querySelector(`.editor-input-${key}`),
      `${key} field present`,
    );
  }
});

test("buildPayload assembles a full, correctly-typed definition", () => {
  const editor = mount();
  fillValid(editor);
  setInput(editor, "bindHost", "127.0.0.1");
  setInput(editor, "lingerMs", "15000");

  const payload = editor.buildPayload();
  assert.equal(payload.name, "Prod DB");
  assert.equal(payload.localPort, 5432); // number, not string
  assert.equal(payload.bindHost, "127.0.0.1");
  assert.deepEqual(payload.destination, { host: "db.internal", port: 5432 });
  assert.deepEqual(payload.sshServer, {
    host: "ssh.example.com",
    port: 22,
    user: "deploy",
    auth: [{ type: "agent" }],
  });
  assert.deepEqual(payload.jumps, []);
  assert.equal(payload.lingerMs, 15000);
});

test("the loopback-exposure warning tracks bindHost", () => {
  const editor = mount();
  const warning = editor.element.querySelector(".editor-bind-warning");
  assert.equal(warning.hidden, true);

  setInput(editor, "bindHost", "0.0.0.0");
  assert.equal(warning.hidden, false, "warns when bound beyond loopback");

  setInput(editor, "bindHost", "127.0.0.1");
  assert.equal(warning.hidden, true, "hidden again for loopback");
});

test("saving an invalid definition shows inline errors and does not submit", async () => {
  let submitted = false;
  const editor = mount({ onSubmit: () => ((submitted = true), {}) });
  submit(editor); // everything empty
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(submitted, false, "onSubmit not called while invalid");
  const nameField = editor.element.querySelector(
    '.field[data-error-key="name"]',
  );
  assert.ok(nameField.classList.contains("field--error"), "name flagged");
  assert.ok(
    editor.element
      .querySelector('.field[data-error-key="localPort"]')
      .classList.contains("field--error"),
    "localPort flagged",
  );
});

// TODO(Feature 45, steps 3–6): the inline TunnelEditor is being replaced by the
// modal editor + credential picker. Its "valid save" now needs a credentialId the
// old inline SSH-server form can't supply, so these two are parked until the
// modal editor + CredentialPickerField land and this suite is rewritten.
test(
  "a valid save submits the payload and fires onSaved",
  {
    skip: "Feature 45: inline editor replaced by modal editor + credential picker",
  },
  async () => {
    const calls = [];
    const record = { id: "t1", name: "Prod DB" };
    const editor = mount({
      onSubmit: (payload, ctx) => {
        calls.push({ payload, ctx });
        return record;
      },
      onSaved: (r) => calls.push({ saved: r }),
    });
    fillValid(editor);
    submit(editor);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.length, 2, "onSubmit then onSaved");
    assert.equal(
      calls[0].ctx.id,
      null,
      "create (no id) for a fresh definition",
    );
    assert.equal(calls[0].payload.name, "Prod DB");
    assert.deepEqual(calls[1].saved, record);
  },
);

test(
  "editing an existing definition submits with its id and masks its secret",
  {
    skip: "Feature 45: inline editor replaced by modal editor + credential picker",
  },
  async () => {
    const calls = [];
    const editor = mount({
      onSubmit: (payload, ctx) => (calls.push({ payload, ctx }), {}),
    });
    editor.setValue({
      id: "t9",
      name: "Existing",
      localPort: 8080,
      destination: { host: "h", port: 80 },
      sshServer: {
        host: "s",
        port: 22,
        user: "u",
        auth: [{ type: "password", hasSecret: true }],
      },
      jumps: [],
    });

    // Change the type-select selection? No — just re-save without touching the
    // secret; it must be retained via hasSecret.
    change(editor.element.querySelector(".editor-input-name"), undefined); // no-op touch
    submit(editor);
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ctx.id, "t9", "update carries the id");
    assert.deepEqual(calls[0].payload.sshServer.auth, [
      { type: "password", hasSecret: true },
    ]);
  },
);
