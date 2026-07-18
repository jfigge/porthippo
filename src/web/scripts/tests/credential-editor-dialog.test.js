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
import { CredentialEditorDialog } from "../components/credential-editor-dialog.js";
import { init as initBuildInfo } from "../build-info.js";
import { t } from "../i18n.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

// Drive the shared build-info singleton to a given capability map for one case,
// then restore the "everything enabled" default so cases don't leak (build-info
// is a module singleton shared across every renderer test).
async function withCaps(capabilities, fn) {
  await initBuildInfo({
    build: { info: async () => ({ distribution: "store", capabilities }) },
  });
  try {
    await fn();
  } finally {
    await initBuildInfo({
      build: {
        info: async () => ({ distribution: "direct", capabilities: {} }),
      },
    });
  }
}

const typeValues = (dlg) =>
  [...dlg.element.querySelectorAll(".cred-type-select option")].map(
    (o) => o.value,
  );

function stub(calls = {}) {
  return {
    credentials: {
      create: async (p) => ((calls.create ||= []).push(p), { id: "c9", ...p }),
      update: async (id, p) => (
        (calls.update ||= []).push({ id, p }),
        { id, ...p }
      ),
    },
  };
}

function mount(calls = {}, onSaved) {
  resetDom();
  const dlg = new CredentialEditorDialog({
    jumphippo: stub(calls),
    openKeyFile: async () => "/picked/key",
    onSaved,
  });
  return dlg;
}

// Mount with a custom key picker (Feature 190 returns `{ path, remembered }`).
function mountPicker(openKeyFile) {
  resetDom();
  return new CredentialEditorDialog({ jumphippo: stub({}), openKeyFile });
}

const keyHint = (dlg) =>
  dlg.element.querySelector('.field[data-error-key="keyPath"] .field-info');

const el = (dlg, sel) => dlg.element.querySelector(sel);

test("a fresh credential defaults to agent auth (no key/secret fields)", () => {
  const dlg = mount();
  dlg.openCreate();
  assert.ok(dlg.element.open);
  assert.ok(el(dlg, ".auth-agent-hint"), "agent hint shown");
  assert.equal(el(dlg, ".cred-keypath-input"), null);
  assert.equal(el(dlg, ".cred-secret-input"), null);
});

test("switching auth type reveals the right fields", () => {
  const dlg = mount();
  dlg.openCreate();

  change(el(dlg, ".cred-type-select"), "key");
  assert.ok(el(dlg, ".cred-keypath-input"), "key path shown for key auth");
  assert.ok(el(dlg, ".cred-secret-input"), "passphrase shown for key auth");

  change(el(dlg, ".cred-type-select"), "password");
  assert.equal(
    el(dlg, ".cred-keypath-input"),
    null,
    "no key path for password",
  );
  assert.ok(el(dlg, ".cred-secret-input"), "password field shown");
});

test("buildPayload carries the fields for the chosen type", () => {
  const dlg = mount();
  dlg.openCreate();
  typeInto(el(dlg, ".cred-label-input"), "Prod");
  typeInto(el(dlg, ".cred-user-input"), "deploy");
  change(el(dlg, ".cred-type-select"), "password");
  typeInto(el(dlg, ".cred-secret-input"), "s3cr3t");

  assert.deepEqual(dlg.buildPayload(), {
    label: "Prod",
    user: "deploy",
    authType: "password",
    password: "s3cr3t",
  });
});

test("Browse fills the key path from the native picker", async () => {
  const dlg = mount();
  dlg.openCreate();
  change(el(dlg, ".cred-type-select"), "key");
  el(dlg, ".auth-browse-btn").click();
  await flush();
  assert.equal(el(dlg, ".cred-keypath-input").value, "/picked/key");
  assert.equal(dlg.buildPayload().keyPath, "/picked/key");
});

test("Browse accepts the { path, remembered } object shape (Feature 190)", async () => {
  const dlg = mountPicker(async () => ({
    path: "/picked/key",
    remembered: true,
  }));
  dlg.openCreate();
  change(el(dlg, ".cred-type-select"), "key");
  assert.equal(keyHint(dlg), null, "no hint before a pick");
  el(dlg, ".auth-browse-btn").click();
  await flush();
  assert.equal(el(dlg, ".cred-keypath-input").value, "/picked/key");
  assert.equal(dlg.buildPayload().keyPath, "/picked/key");
  // A durable bookmark → the "remembered for this Mac" reassurance appears.
  assert.equal(keyHint(dlg)?.title, t("auth.keyRemembered"));
});

test("Browse without a durable bookmark shows no remembered hint", async () => {
  const dlg = mountPicker(async () => ({
    path: "/picked/key",
    remembered: false,
  }));
  dlg.openCreate();
  change(el(dlg, ".cred-type-select"), "key");
  el(dlg, ".auth-browse-btn").click();
  await flush();
  assert.equal(el(dlg, ".cred-keypath-input").value, "/picked/key");
  assert.equal(keyHint(dlg), null, "no hint for a non-remembered pick");
});

// ── Re-pick nudge (Feature 190): a stored key with no bookmark (MAS) ───────────

const warnEl = (dlg) => dlg.element.querySelector(".auth-keypath-warning");

test("a stored key with no bookmark shows the re-pick nudge on edit", async () => {
  resetDom();
  const dlg = new CredentialEditorDialog({
    jumphippo: stub({}),
    keyStatus: async () => ({ needsRepick: true }),
  });
  dlg.openEdit({
    id: "c1",
    label: "Bastion",
    user: "ec2-user",
    authType: "key",
    keyPath: "/Users/j/.ssh/x.pem",
  });
  await flush(); // let the async key-status query resolve + re-render
  assert.ok(warnEl(dlg), "re-pick warning shown");
  assert.equal(warnEl(dlg).textContent, t("auth.keyNeedsRepick"));
});

test("a stored key that IS bookmarked shows no nudge", async () => {
  resetDom();
  const dlg = new CredentialEditorDialog({
    jumphippo: stub({}),
    keyStatus: async () => ({ needsRepick: false }),
  });
  dlg.openEdit({
    id: "c1",
    label: "Bastion",
    user: "ec2-user",
    authType: "key",
    keyPath: "/Users/j/.ssh/x.pem",
  });
  await flush();
  assert.equal(warnEl(dlg), null, "no nudge when the key is accessible");
});

test("re-picking a nudged key clears the warning and shows the remembered hint", async () => {
  resetDom();
  let bookmarked = false;
  const dlg = new CredentialEditorDialog({
    jumphippo: stub({}),
    keyStatus: async () => ({ needsRepick: !bookmarked }),
    openKeyFile: async () => {
      bookmarked = true; // the re-pick mints the bookmark
      return { path: "/Users/j/.ssh/x.pem", remembered: true };
    },
  });
  dlg.openEdit({
    id: "c1",
    label: "Bastion",
    user: "ec2-user",
    authType: "key",
    keyPath: "/Users/j/.ssh/x.pem",
  });
  await flush();
  assert.ok(warnEl(dlg), "nudge shown before re-pick");

  el(dlg, ".auth-browse-btn").click();
  await flush();
  assert.equal(warnEl(dlg), null, "warning cleared after re-pick");
  assert.equal(
    keyHint(dlg)?.title,
    t("auth.keyRemembered"),
    "remembered reassurance shown instead",
  );
});

test("a valid create persists, closes, emits, and calls onSaved", async () => {
  const calls = {};
  const saved = [];
  const changed = [];
  const dlg = mount(calls, (r) => saved.push(r));
  window.addEventListener("jumphippo:credentials-changed", (e) =>
    changed.push(e.detail),
  );
  dlg.openCreate();
  typeInto(el(dlg, ".cred-label-input"), "Prod");
  typeInto(el(dlg, ".cred-user-input"), "deploy");

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();

  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].label, "Prod");
  assert.ok(!dlg.element.open, "dialog closed on success");
  assert.deepEqual(changed[0], { id: "c9" });
  assert.equal(saved.length, 1);
});

test("an invalid credential shows a field error and does not persist", async () => {
  const calls = {};
  const dlg = mount(calls);
  dlg.openCreate();
  // No label / user.
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.create, undefined, "no store write");
  assert.ok(
    dlg.element
      .querySelector('.field[data-error-key="label"]')
      .classList.contains("field--error"),
  );
});

test("editing keeps a stored secret when it isn't retyped", async () => {
  const calls = {};
  const dlg = mount(calls);
  dlg.openEdit({
    id: "c1",
    label: "Prod",
    user: "deploy",
    authType: "password",
    hasSecret: true,
  });
  // The secret field advertises a stored value.
  assert.equal(
    el(dlg, ".auth-secret-status").hidden,
    false,
    "shows •••• set for a stored secret",
  );

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.deepEqual(calls.update[0].p, {
    label: "Prod",
    user: "deploy",
    authType: "password",
    hasSecret: true, // retained, no plaintext resent
  });
});

// ── Store-build gating (ssh-agent auth unavailable in the MAS sandbox) ─────────

test("a build without ssh-agent hides the agent option and defaults new creds to key", async () => {
  await withCaps({ sshAgentAuth: false }, () => {
    const dlg = mount();
    dlg.openCreate();
    assert.deepEqual(typeValues(dlg), ["key", "password"], "no agent option");
    assert.equal(el(dlg, ".auth-agent-hint"), null, "no agent hint");
    assert.ok(el(dlg, ".cred-keypath-input"), "defaults to key auth fields");
  });
});

test("editing an existing agent credential in that build shows it with a warning", async () => {
  await withCaps({ sshAgentAuth: false }, () => {
    const dlg = mount();
    dlg.openEdit({ id: "c1", label: "L", user: "u", authType: "agent" });
    // The agent option is re-added so the loaded credential still displays…
    assert.deepEqual(typeValues(dlg), ["agent", "key", "password"]);
    // …and the fields warn that it can't authenticate here.
    assert.ok(el(dlg, ".auth-agent-warning"), "agent warning shown");
  });
});

test("agent stays available in a normal (direct) build", () => {
  const dlg = mount();
  dlg.openCreate();
  assert.deepEqual(typeValues(dlg), ["agent", "key", "password"]);
  assert.ok(el(dlg, ".auth-agent-hint"), "normal agent hint");
});
