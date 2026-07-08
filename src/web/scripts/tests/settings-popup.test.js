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
import { SettingsPopup } from "../components/settings-popup.js";
import { PopupManager } from "../popup-manager.js";

// PopupManager caches one overlay in module state; resetting the DOM per test
// would strand the popup in a detached document. Use a single DOM for the file
// and just close the popup between tests.
const window = resetDom();

function stubBridge(overrides = {}) {
  const calls = { set: [], copy: 0 };
  const settings = {
    theme: "system",
    language: "system",
    defaultLingerMs: 10000,
    defaultBindHost: "127.0.0.1",
    defaultKeepAlive: false,
    launchAtLogin: false,
    startMinimized: false,
    armOnLaunch: true,
    confirmOnQuit: false,
    ...overrides,
  };
  const porthippo = {
    settings: {
      get: async () => ({ ...settings }),
      set: (patch) => {
        calls.set.push(patch);
        return Promise.resolve(patch);
      },
    },
    diagnostics: {
      copy: () => {
        calls.copy++;
        return Promise.resolve("report");
      },
    },
  };
  return { porthippo, calls };
}

test("open populates controls from the loaded settings", async () => {
  const { porthippo } = stubBridge({ theme: "dark", defaultLingerMs: 2500 });
  const popup = new SettingsPopup({ porthippo });
  await popup.open();

  const el = document.querySelector(".popup-settings");
  assert.ok(el, "settings popup mounted");
  assert.equal(el.querySelector("#setting-theme").value, "dark");
  assert.equal(el.querySelector("#setting-lingerMs").value, "2500");
  assert.equal(el.querySelector("#setting-armOnLaunch").checked, true);
});

test("changing a control persists the full settings and broadcasts", async () => {
  PopupManager.close();
  const { porthippo, calls } = stubBridge();
  const popup = new SettingsPopup({ porthippo });
  await popup.open();

  const events = [];
  window.addEventListener("porthippo:settings-changed", (e) =>
    events.push(e.detail),
  );

  change(document.querySelector("#setting-theme"), "light");

  assert.equal(calls.set.length, 1);
  assert.equal(calls.set[0].theme, "light");
  // The whole object is sent, not just the delta.
  assert.equal(calls.set[0].defaultBindHost, "127.0.0.1");
  assert.equal(events.length, 1);
  assert.equal(events[0].theme, "light");
});

test("switching tabs shows the matching panel", async () => {
  const { porthippo } = stubBridge();
  const popup = new SettingsPopup({ porthippo });
  await popup.open();

  const el = document.querySelector(".popup-settings");
  const behaviourTab = el.querySelector(
    '.settings-nav-item[data-panel="behaviour"]',
  );
  behaviourTab.dispatchEvent(new window.Event("click", { bubbles: true }));

  assert.equal(
    el.querySelector('.settings-panel[data-panel="behaviour"]').hidden,
    false,
  );
  assert.equal(
    el.querySelector('.settings-panel[data-panel="appearance"]').hidden,
    true,
  );
  assert.equal(
    behaviourTab.classList.contains("settings-nav-item--active"),
    true,
  );
});

test("the copy-diagnostics button calls the bridge", async () => {
  PopupManager.close();
  const { porthippo, calls } = stubBridge();
  const popup = new SettingsPopup({ porthippo });
  await popup.open();

  const btn = [...document.querySelectorAll(".settings-footer .btn")].find(
    (b) => b.classList.contains("btn--ghost"),
  );
  btn.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert.equal(calls.copy, 1);
});
