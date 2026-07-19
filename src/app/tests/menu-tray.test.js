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
    copyDiagnostics: () => fired.push("copyDiagnostics"),
    showLogs: () => fired.push("showLogs"),
    about: () => fired.push("about"),
    checkUpdates: () => fired.push("checkUpdates"),
    quit: () => fired.push("quit"),
  };

  const menu = installAppMenu({
    app: { name: "Jump Hippo" },
    Menu,
    label,
    actions,
  });
  assert.equal(Menu.calls.applied.length, 1);
  const template = menu.template;

  findItem(template, "New Tunnel").click();
  findItem(template, "Arm All Tunnels").click();
  findItem(template, "Copy Diagnostics").click();
  assert.deepEqual(fired, ["newTunnel", "armAll", "copyDiagnostics"]);
});

test("installAppMenu adds a per-group arm-all/disarm-all submenu (Feature 140)", () => {
  const Menu = fakeMenu();
  const fired = [];
  const menu = installAppMenu({
    app: { name: "Jump Hippo" },
    Menu,
    label,
    groups: [{ id: "g1", name: "Work" }],
    actions: {
      armGroup: (id) => fired.push(`armGroup:${id}`),
      disarmGroup: (id) => fired.push(`disarmGroup:${id}`),
    },
  });
  const groups = findItem(menu.template, "Groups");
  assert.ok(groups && groups.submenu, "Groups submenu present");
  const work = findItem(groups.submenu, "Work");
  assert.ok(work && work.submenu, "per-group submenu present");
  work.submenu.find((i) => i.label === "Arm All").click();
  work.submenu.find((i) => i.label === "Disarm All").click();
  assert.deepEqual(fired, ["armGroup:g1", "disarmGroup:g1"]);
});

test("installAppMenu omits the Groups submenu when there are no groups", () => {
  const Menu = fakeMenu();
  const menu = installAppMenu({
    app: { name: "Jump Hippo" },
    Menu,
    label,
    actions: {},
  });
  assert.equal(findItem(menu.template, "Groups"), null);
});

test("the About item routes to the about action (in-app dialog)", () => {
  const Menu = fakeMenu();
  const fired = [];
  const menu = installAppMenu({
    app: { name: "Jump Hippo" },
    Menu,
    label,
    actions: { about: () => fired.push("about") },
  });
  const about = findItem(menu.template, "About Jump Hippo");
  assert.ok(about, "About item present");
  assert.equal(typeof about.click, "function", "About uses a click handler");
  assert.ok(!about.role, "About is not the native about role");
  about.click();
  assert.deepEqual(fired, ["about"]);
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
    popUpContextMenu() {
      popUps.push(true);
    }
    destroy() {}
  }
  const popUps = [];

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

  // A tray-icon click must NOT auto-open the window (regression guard) — only the
  // menu's "Show" item does. On macOS the click opens the context menu via
  // setContextMenu; on Windows/Linux the handler pops it up. Never a window.
  clickHandlers.click();
  assert.ok(!fired.includes("show"), "a tray click does not open the window");
  if (process.platform !== "darwin") {
    assert.equal(popUps.length, 1, "off macOS a click pops up the menu");
  }

  // The Show menu item is what actually opens the window.
  findItem(template, "tray.show").click();
  assert.ok(fired.includes("show"), "the Show item opens the window");
});

test("a tray click on Windows pops up the menu instead of opening the window", () => {
  const Menu = fakeMenu();
  const original = process.platform;
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
  const popUps = [];
  const fired = [];
  const clickHandlers = {};
  class FakeTray {
    on(event, cb) {
      clickHandlers[event] = cb;
    }
    setToolTip() {}
    setContextMenu() {}
    popUpContextMenu() {
      popUps.push(true);
    }
    destroy() {}
  }
  try {
    createTray({
      Tray: FakeTray,
      Menu,
      image: { fake: true },
      t,
      getStatus: () => ({ tunnels: [], total: 0, active: 0 }),
      actions: { showWindow: () => fired.push("show") },
    });
    clickHandlers.click();
    assert.deepEqual(popUps, [true], "the menu is popped up");
    assert.deepEqual(fired, [], "the window is never opened by a click");
  } finally {
    Object.defineProperty(process, "platform", {
      value: original,
      configurable: true,
    });
  }
});

test("createTray adds per-group arm-all/disarm-all submenus (Feature 140)", () => {
  const Menu = fakeMenu();
  let contextMenu = null;
  class FakeTray {
    on() {}
    setToolTip() {}
    setContextMenu(m) {
      contextMenu = m;
    }
  }
  const fired = [];
  createTray({
    Tray: FakeTray,
    Menu,
    image: {},
    t,
    getStatus: () => ({
      tunnels: [{ id: "a", name: "A", state: "connected" }],
      total: 1,
      active: 1,
      connected: 1,
      groups: [{ id: "g1", name: "Work", ids: ["a"], armed: 1, total: 1 }],
    }),
    actions: {
      armGroup: (id) => fired.push(`armGroup:${id}`),
      disarmGroup: (id) => fired.push(`disarmGroup:${id}`),
    },
  });
  const work = findItem(contextMenu.template, "Work");
  assert.ok(work && work.submenu, "group submenu present");
  const armAll = work.submenu.find((i) => i.label === "tray.group.armAll");
  const disarmAll = work.submenu.find(
    (i) => i.label === "tray.group.disarmAll",
  );
  // Fully armed → arm-all disabled, disarm-all enabled (and calls disarmGroup).
  assert.equal(armAll.enabled, false);
  assert.equal(disarmAll.enabled, true);
  disarmAll.click();
  assert.deepEqual(fired, ["disarmGroup:g1"]);
});

test("createTray rebuilds its icon from status so the badge tracks connections", () => {
  const Menu = fakeMenu();
  const images = [];
  class FakeTray {
    on() {}
    setToolTip() {}
    setContextMenu() {}
    setImage(img) {
      images.push(img);
    }
  }
  const status = { tunnels: [], total: 3, active: 3, connected: 2 };
  const seenCounts = [];
  const renderImage = (s) => {
    seenCounts.push(s.connected);
    return { badge: s.connected };
  };

  const tray = createTray({
    Tray: FakeTray,
    Menu,
    image: renderImage(status),
    renderImage,
    t,
    getStatus: () => status,
    actions: {},
  });

  // Built once on construction; update() re-renders from the latest status.
  assert.deepEqual(images.at(-1), { badge: 2 });
  status.connected = 0;
  tray.update();
  assert.deepEqual(images.at(-1), { badge: 0 });
  assert.deepEqual(seenCounts.slice(-1), [0]);
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
