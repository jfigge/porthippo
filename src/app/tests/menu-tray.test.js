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

const { installAppMenu } = require("../menu");
const { createTray } = require("../tray");

// A label resolver that just returns the fallback (or the key) — so tests match
// against the English fallbacks without loading a catalog.
const label = (key, fallback) => fallback || key;
const t = (key, params) => {
  if (key === "tray.tooltip") return `PH — ${params.active}/${params.total}`;
  if (key === "tray.tooltip.none") return "PH — none";
  return key;
};

// A fake Menu whose buildFromTemplate returns the template so tests can walk it.
function fakeMenu() {
  const calls = { applied: [] };
  return {
    calls,
    buildFromTemplate: (template) => ({ template }),
    setApplicationMenu: (menu) => calls.applied.push(menu),
  };
}

// Recursively find the first item with the given label.
function findItem(items, wantLabel) {
  for (const item of items || []) {
    if (item.label === wantLabel) return item;
    if (item.submenu) {
      const nested = findItem(item.submenu, wantLabel);
      if (nested) return nested;
    }
  }
  return null;
}

test("installAppMenu builds and installs a menu and wires custom items", () => {
  const Menu = fakeMenu();
  const fired = [];
  const actions = {
    newTunnel: () => fired.push("newTunnel"),
    armAll: () => fired.push("armAll"),
    disarmAll: () => fired.push("disarmAll"),
    openSettings: () => fired.push("openSettings"),
    setView: (v) => fired.push(`setView:${v}`),
    copyDiagnostics: () => fired.push("copyDiagnostics"),
    showLogs: () => fired.push("showLogs"),
    about: () => fired.push("about"),
    checkUpdates: () => fired.push("checkUpdates"),
    quit: () => fired.push("quit"),
  };

  const menu = installAppMenu({
    app: { name: "Port Hippo" },
    Menu,
    label,
    actions,
  });
  assert.equal(Menu.calls.applied.length, 1);
  const template = menu.template;

  findItem(template, "New Tunnel").click();
  findItem(template, "Arm All Tunnels").click();
  findItem(template, "Copy Diagnostics").click();
  findItem(template, "Definition").click();
  assert.deepEqual(fired, [
    "newTunnel",
    "armAll",
    "copyDiagnostics",
    "setView:definition",
  ]);
});

test("createTray sets a status tooltip and per-tunnel arm/disarm items", () => {
  const Menu = fakeMenu();
  let toolTip = null;
  let contextMenu = null;
  const clickHandlers = {};

  class FakeTray {
    constructor(image) {
      this.image = image;
    }
    on(event, cb) {
      clickHandlers[event] = cb;
    }
    setToolTip(text) {
      toolTip = text;
    }
    setContextMenu(menu) {
      contextMenu = menu;
    }
    destroy() {}
  }

  const fired = [];
  const status = {
    tunnels: [
      { id: "a", name: "Alpha", state: "connected" },
      { id: "b", name: "Beta", state: "disarmed" },
    ],
    total: 2,
    active: 1,
  };

  createTray({
    Tray: FakeTray,
    Menu,
    image: { fake: true },
    t,
    getStatus: () => status,
    actions: {
      showWindow: () => fired.push("show"),
      armAll: () => fired.push("armAll"),
      disarmAll: () => fired.push("disarmAll"),
      arm: (id) => fired.push(`arm:${id}`),
      disarm: (id) => fired.push(`disarm:${id}`),
      openSettings: () => fired.push("settings"),
      copyDiagnostics: () => fired.push("diag"),
      quit: () => fired.push("quit"),
    },
  });

  assert.equal(toolTip, "PH — 1/2");
  const template = contextMenu.template;

  // Alpha is connected → its Arm is disabled, Disarm enabled (and calls disarm).
  const alpha = findItem(template, "Alpha — state.connected");
  assert.ok(alpha, "per-tunnel submenu present");
  const alphaArm = alpha.submenu.find((i) => i.label === "mon.arm");
  const alphaDisarm = alpha.submenu.find((i) => i.label === "mon.disarm");
  assert.equal(alphaArm.enabled, false);
  assert.equal(alphaDisarm.enabled, true);
  alphaDisarm.click();
  assert.deepEqual(fired, ["disarm:a"]);

  // The tray click shows the window.
  clickHandlers.click();
  assert.ok(fired.includes("show"));
});

test("createTray shows the empty hint and disarm-all only when active", () => {
  const Menu = fakeMenu();
  let contextMenu = null;
  class FakeTray {
    on() {}
    setToolTip() {}
    setContextMenu(m) {
      contextMenu = m;
    }
  }
  createTray({
    Tray: FakeTray,
    Menu,
    image: {},
    t,
    getStatus: () => ({ tunnels: [], total: 0, active: 0 }),
    actions: {},
  });
  const template = contextMenu.template;
  assert.ok(findItem(template, "def.list.empty"), "empty hint shown");
  // With nothing active, Disarm All is disabled; Arm All also (nothing to arm).
  const disarmAll = findItem(template, "tray.disarmAll");
  assert.equal(disarmAll.enabled, false);
});
