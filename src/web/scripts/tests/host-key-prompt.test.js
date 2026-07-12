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

// host-key-prompt.test.js — the security-critical TOFU mediation: an unknown key
// prompts trust/reject (the answer routed back to the engine by promptId), a
// *changed* key only warns (the engine already hard-rejected it), and a payload
// with no promptId is ignored.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { HostKeyPrompt } from "../host-key-prompt.js";
import { PopupManager } from "../popup-manager.js";

function stubHostkeys(calls = {}) {
  return {
    hostkeys: {
      trust: (id) => (calls.trust ||= []).push(id),
      reject: (id) => (calls.reject ||= []).push(id),
    },
  };
}

function unknown(detail) {
  window.dispatchEvent(
    new CustomEvent("porthippo:hostkey-unknown", { detail }),
  );
}
function changed(detail) {
  window.dispatchEvent(
    new CustomEvent("porthippo:hostkey-changed", { detail }),
  );
}

const INFO = {
  promptId: "p-1",
  host: "db.example.com",
  port: 22,
  fingerprint: "SHA256:abc",
};

test("an unknown key prompts and Trust routes back to hostkeys.trust(promptId)", () => {
  resetDom();
  const calls = {};
  const prompt = new HostKeyPrompt({
    porthippo: stubHostkeys(calls),
  }).install();
  try {
    unknown(INFO);

    const dialog = document.querySelector(".popup-confirm");
    assert.ok(dialog, "an unknown key opens a confirm");
    assert.ok(
      dialog.textContent.includes("SHA256:abc"),
      "the fingerprint is shown so the user can verify it",
    );

    // The confirm (primary) button trusts.
    document.querySelector(".popup-confirm .btn--primary").click();
    assert.deepEqual(calls.trust, ["p-1"], "trust was sent with the promptId");
    assert.equal(calls.reject, undefined, "reject was not sent");
  } finally {
    prompt.uninstall();
    PopupManager.close();
  }
});

test("an unknown key that the user rejects routes back to hostkeys.reject(promptId)", () => {
  resetDom();
  const calls = {};
  const prompt = new HostKeyPrompt({
    porthippo: stubHostkeys(calls),
  }).install();
  try {
    unknown(INFO);
    // The cancel (secondary) button rejects.
    document.querySelector(".popup-confirm .btn--secondary").click();
    assert.deepEqual(
      calls.reject,
      ["p-1"],
      "reject was sent with the promptId",
    );
    assert.equal(calls.trust, undefined, "trust was not sent");
  } finally {
    prompt.uninstall();
    PopupManager.close();
  }
});

test("a CHANGED key only warns — it never offers to trust", () => {
  resetDom();
  const calls = {};
  const prompt = new HostKeyPrompt({
    porthippo: stubHostkeys(calls),
  }).install();
  try {
    changed({ host: "db.example.com", port: 22 });

    // A one-button warning, NOT a two-button confirm (the engine already rejected).
    assert.ok(document.querySelector(".popup-notify"), "shows a warning");
    assert.equal(
      document.querySelector(".popup-confirm"),
      null,
      "no trust/reject confirm for a changed key",
    );
    // There is no way to trust from here.
    assert.equal(calls.trust, undefined);
    assert.equal(calls.reject, undefined);
  } finally {
    prompt.uninstall();
    PopupManager.close();
  }
});

test("a payload with no promptId is ignored (no popup, no call)", () => {
  resetDom();
  const calls = {};
  const prompt = new HostKeyPrompt({
    porthippo: stubHostkeys(calls),
  }).install();
  try {
    unknown({ host: "db.example.com", port: 22 }); // no promptId
    assert.equal(document.querySelector(".popup-confirm"), null, "no prompt");
    assert.equal(calls.trust, undefined);
    assert.equal(calls.reject, undefined);
  } finally {
    prompt.uninstall();
    PopupManager.close();
  }
});

test("uninstall() stops mediating — a later unknown key raises no prompt", () => {
  resetDom();
  const calls = {};
  const prompt = new HostKeyPrompt({
    porthippo: stubHostkeys(calls),
  }).install();
  prompt.uninstall();
  try {
    unknown(INFO);
    assert.equal(
      document.querySelector(".popup-confirm"),
      null,
      "no prompt after uninstall",
    );
    assert.equal(calls.trust, undefined);
  } finally {
    PopupManager.close();
  }
});
