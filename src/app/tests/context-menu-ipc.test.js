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

/**
 * tests/context-menu-ipc.test.js — the native row context-menu popup contract:
 * `menu:popup` turns a renderer template into a native Menu (separators pass
 * through, `enabled` defaults to true), resolves with the clicked item's id, and
 * resolves `null` when the menu is dismissed or the template is empty. Uses a
 * fake ipcMain + Menu so no Electron process is started.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { registerContextMenuIPC } = require("../ipc/context-menu");

function harness() {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  let built = null;
  const Menu = {
    buildFromTemplate(template) {
      const menu = {
        template,
        _callback: null,
        popup(opts) {
          menu._callback = (opts && opts.callback) || null;
        },
        clickLabel(label) {
          const item = template.find((i) => i.label === label);
          item?.click?.();
          return menu;
        },
        close() {
          menu._callback?.();
        },
      };
      built = menu;
      return menu;
    },
  };
  registerContextMenuIPC({
    ipcMain,
    Menu,
    getMainWindow: () => ({ id: "win" }),
  });
  return { popup: handlers.get("menu:popup"), getBuilt: () => built };
}

test("menu:popup builds the template and resolves the clicked item's id", async () => {
  const { popup, getBuilt } = harness();
  const result = popup(null, {
    items: [
      { id: "edit", label: "Edit" },
      { type: "separator" },
      { id: "pause", label: "Pause", enabled: false },
    ],
  });
  const menu = getBuilt();
  // The native template mirrors the request: labeled items keep their label,
  // `enabled` defaults to true, and separators pass straight through.
  assert.equal(menu.template.length, 3);
  assert.equal(menu.template[0].label, "Edit");
  assert.equal(menu.template[0].enabled, true);
  assert.equal(menu.template[1].type, "separator");
  assert.equal(menu.template[2].enabled, false);

  menu.clickLabel("Edit").close();
  assert.equal(await result, "edit");
});

test("menu:popup supports nested submenus and resolves a clicked leaf's id", async () => {
  const { popup, getBuilt } = harness();
  const result = popup(null, {
    items: [
      { id: "edit", label: "Edit" },
      {
        label: "Assign",
        submenu: [
          { id: "assign:g1", label: "Work" },
          { id: "assign:__ungrouped", label: "Ungrouped" },
        ],
      },
    ],
  });
  const menu = getBuilt();
  const assign = menu.template.find((i) => i.label === "Assign");
  assert.ok(Array.isArray(assign.submenu), "the submenu is translated too");
  assert.equal(assign.click, undefined, "a submenu parent has no click");
  const leaf = assign.submenu.find((i) => i.label === "Work");
  leaf.click();
  menu.close();
  assert.equal(await result, "assign:g1");
});

test("menu:popup resolves null when the menu is dismissed with no selection", async () => {
  const { popup, getBuilt } = harness();
  const result = popup(null, { items: [{ id: "x", label: "X" }] });
  getBuilt().close(); // closed without clicking anything
  assert.equal(await result, null);
});

test("menu:popup resolves null (not the string 'undefined') for an id-less item", async () => {
  // Regression: click resolved String(item.id), so an item with a missing id
  // surfaced the literal "undefined" at the IPC boundary instead of a dismissal.
  const { popup, getBuilt } = harness();
  const result = popup(null, { items: [{ label: "Orphan" }] });
  getBuilt().clickLabel("Orphan").close();
  assert.equal(await result, null);
});

test("menu:popup resolves null (and shows nothing) for an empty template", async () => {
  const { popup, getBuilt } = harness();
  const result = popup(null, { items: [] });
  assert.equal(getBuilt(), null, "no menu is built for an empty template");
  assert.equal(await result, null);
});
