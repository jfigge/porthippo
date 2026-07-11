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

import { resetDom } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AboutDialog } from "../components/about-dialog.js";
import { PopupManager } from "../popup-manager.js";

// PopupManager keeps its active popup in module state; keep a single DOM for the
// file and just close the popup between tests (mirrors settings-popup.test.js).
resetDom();
const tick = () => new Promise((r) => setTimeout(r, 0));

function stubBridge() {
  window.porthippo = {
    getVersion: async () => "1.2.3",
    platform: "darwin",
    arch: "arm64",
    electron: "42.0.0",
  };
}

test("open() mounts a branded card with name, subtitle and Close", async () => {
  stubBridge();
  AboutDialog.open();
  await tick();

  const root = document.querySelector(".about-dialog");
  assert.ok(root, "about dialog mounted");
  assert.equal(root.querySelector(".about-name").textContent, "Port Hippo");
  assert.ok(root.querySelector(".about-subtitle").textContent.length > 0);
  assert.ok(root.querySelector(".about-logo"), "logo present");
  assert.ok(root.querySelector(".about-close"), "close button present");

  PopupManager.close();
});

test("the (i) button toggles the version/build details from the bridge", async () => {
  stubBridge();
  AboutDialog.open();
  await tick();

  const root = document.querySelector(".about-dialog");
  const build = root.querySelector(".about-build");
  const info = root.querySelector(".about-info-btn");

  assert.equal(build.hasAttribute("hidden"), true, "details start hidden");
  info.click();
  assert.equal(build.hasAttribute("hidden"), false, "click reveals details");
  assert.equal(info.getAttribute("aria-expanded"), "true");
  assert.match(build.textContent, /v1\.2\.3/);
  assert.match(build.textContent, /darwin\/arm64/);
  assert.match(build.textContent, /42\.0\.0/);

  info.click();
  assert.equal(build.hasAttribute("hidden"), true, "click again hides details");

  PopupManager.close();
});

test("falls back to a dev-build label when no version is available", async () => {
  window.porthippo = { getVersion: async () => null };
  AboutDialog.open();
  await tick();

  const build = document.querySelector(".about-build");
  document.querySelector(".about-info-btn").click();
  assert.match(build.textContent, /dev build/);

  PopupManager.close();
});

test("Close and mask click both dismiss the dialog", async () => {
  stubBridge();

  AboutDialog.open();
  await tick();
  document.querySelector(".about-close").click();
  assert.equal(
    document.querySelector(".about-dialog"),
    null,
    "Close dismisses",
  );

  AboutDialog.open();
  await tick();
  // A click on the backdrop (target === the dialog itself) dismisses via onMaskClick.
  document.querySelector(".popup-dialog").click();
  assert.equal(
    document.querySelector(".about-dialog"),
    null,
    "mask click dismisses",
  );
});
