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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createLoginItem } = require("../login-item");

// A stand-in for Electron's app.getLoginItemSettings/setLoginItemSettings.
function fakeApp() {
  const state = { openAtLogin: false, openAsHidden: false };
  return {
    calls: [],
    getLoginItemSettings: () => ({ ...state }),
    setLoginItemSettings: (opts) => {
      Object.assign(state, opts);
      state.calls?.push?.(opts);
    },
    _state: state,
  };
}

test("macOS/Windows delegate to Electron's setLoginItemSettings", () => {
  for (const platform of ["darwin", "win32"]) {
    const app = fakeApp();
    const item = createLoginItem({ app, platform });

    assert.equal(item.isEnabled(), false);
    item.set(true, { openAsHidden: true });
    assert.equal(app._state.openAtLogin, true);
    assert.equal(app._state.openAsHidden, true);
    assert.equal(item.isEnabled(), true);

    item.set(false);
    assert.equal(app._state.openAtLogin, false);
    assert.equal(item.isEnabled(), false);
  }
});

test("Linux writes and removes a .desktop autostart entry", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-home-"));
  try {
    const item = createLoginItem({
      platform: "linux",
      homedir: () => home,
      exePath: "/opt/PortHippo/porthippo",
      appName: "Port Hippo",
    });
    const desktop = path.join(
      home,
      ".config",
      "autostart",
      "porthippo.desktop",
    );

    assert.equal(item.isEnabled(), false);
    item.set(true);
    assert.equal(item.isEnabled(), true);
    const content = fs.readFileSync(desktop, "utf8");
    assert.match(content, /^\[Desktop Entry\]/);
    assert.match(content, /Exec=\/opt\/PortHippo\/porthippo/);
    assert.match(content, /X-GNOME-Autostart-enabled=true/);

    item.set(false);
    assert.equal(item.isEnabled(), false);
    assert.equal(fs.existsSync(desktop), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("operations never throw when the backend fails", () => {
  // Linux path with a homedir that explodes → swallowed, returns false.
  const errors = [];
  const item = createLoginItem({
    platform: "linux",
    homedir: () => {
      throw new Error("no home");
    },
    onError: (...a) => errors.push(a.join(" ")),
  });
  assert.doesNotThrow(() => item.set(true));
  assert.equal(item.isEnabled(), false);
  assert.ok(errors.length >= 1);
});
