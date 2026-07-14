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
 * ipc/context-menu.js — native OS context-menu popups requested by the renderer.
 *
 * The sandboxed renderer can build an HTML menu, but only the main process can
 * pop a real OS-native menu at the cursor. So the renderer sends a *template* —
 * a flat list of `{ id, label, enabled }` items and `{ type: "separator" }`
 * dividers — and awaits the id of the clicked item (or `null` when dismissed).
 * All labels are resolved renderer-side (single i18n source), so this handler is
 * a dumb popup: it never runs renderer-supplied code, only records which item id
 * was chosen and resolves with it. Used by the tunnel-row right-click menu
 * (Edit / Pause·Play / Arm·Disarm / Clone / Delete).
 *
 * Every channel registered here MUST have a matching `window.porthippo.*`
 * exposure in preload.js AND this file must be listed in the ipc-parity test's
 * scan set (tests/ipc-parity.test.js) — the guard fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {typeof Electron.Menu} deps.Menu
 * @param {() => Electron.BrowserWindow | null} [deps.getMainWindow]  window the
 *        menu is anchored to (falls back to the focused window when absent).
 */
function registerContextMenuIPC({ ipcMain, Menu, getMainWindow }) {
  ipcMain.handle("menu:popup", (_event, request) =>
    popupMenu({ Menu, getMainWindow, request }),
  );
}

/** Build the menu from the sanitized template, pop it, resolve the clicked id. */
function popupMenu({ Menu, getMainWindow, request }) {
  const items = Array.isArray(request && request.items) ? request.items : [];
  return new Promise((resolve) => {
    // A click handler only records the choice; the popup `callback` (fired once
    // when the menu closes for any reason) is the single resolve point, so the
    // click-vs-close ordering can't drop or double-resolve a selection.
    let chosen = null;
    const template = items.map((item) => {
      if (!item || item.type === "separator") return { type: "separator" };
      return {
        label: String(item.label == null ? "" : item.label),
        enabled: item.enabled !== false,
        click: () => {
          chosen = String(item.id);
        },
      };
    });

    if (template.length === 0) {
      resolve(null);
      return;
    }

    const menu = Menu.buildFromTemplate(template);
    const win = (getMainWindow && getMainWindow()) || undefined;
    menu.popup({ window: win, callback: () => resolve(chosen) });
  });
}

module.exports = { registerContextMenuIPC };
