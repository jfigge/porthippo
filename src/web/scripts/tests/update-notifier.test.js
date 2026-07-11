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

// update-notifier.test.js — the renderer surface for the auto-update lifecycle.
// Asserts a downloaded update always offers a restart (calling updater.install),
// and that manual checks toast while silent startup checks stay quiet.

import { resetDom } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { UpdateNotifier } from "../update-notifier.js";
import { PopupManager } from "../popup-manager.js";

function setup() {
  const win = resetDom();
  PopupManager.close();
  const calls = { install: 0 };
  win.porthippo = { updater: { install: () => (calls.install += 1) } };
  new UpdateNotifier({ porthippo: win.porthippo }).install();
  return { win, calls };
}

function emit(win, name, detail) {
  win.dispatchEvent(new win.CustomEvent(name, { detail }));
}

test("a downloaded update offers a restart that calls updater.install", () => {
  const { win, calls } = setup();
  emit(win, "porthippo:update-downloaded", { version: "1.2.3" });

  const confirm = document.querySelector(".popup-confirm");
  assert.ok(confirm, "a restart confirm is shown");
  assert.match(confirm.textContent, /1\.2\.3/, "names the version");

  confirm.querySelector(".btn--primary").click(); // "Restart & install"
  assert.equal(calls.install, 1, "install was invoked");
});

test("a manual up-to-date check toasts; a silent one stays quiet", () => {
  let { win } = setup();
  emit(win, "porthippo:update-not-available", { manual: true });
  assert.ok(
    document.querySelector(".popup-notify"),
    "a manual check shows a toast",
  );

  ({ win } = setup()); // fresh DOM + notifier
  emit(win, "porthippo:update-not-available", { manual: false });
  assert.equal(
    document.querySelector(".popup-dialog"),
    null,
    "a silent startup check shows nothing",
  );
});

test("a manual error is surfaced", () => {
  const { win } = setup();
  emit(win, "porthippo:update-error", { manual: true, message: "no network" });
  const notify = document.querySelector(".popup-notify");
  assert.ok(notify, "the error is shown");
  assert.match(notify.textContent, /no network/);
});
