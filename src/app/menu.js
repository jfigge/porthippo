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
 * menu.js — the native application menu.
 *
 * Built from a localized template and installed with `Menu.setApplicationMenu`.
 * Electron `role` items (cut/copy/paste, reload, minimize, …) carry their own
 * platform-localized labels; only Jump Hippo's custom items are labelled through
 * the injected `label(key, fallback)` resolver. Custom items either invoke a
 * main-process action directly (arm-all, quit, copy-diagnostics) or dispatch a
 * command to the renderer (new-tunnel, settings, view switch) via the `actions`
 * bag wired in main.js.
 *
 * `Menu`/`app` are injected (not `require("electron")`d) so main owns the
 * Electron surface and this module stays a pure template builder. Re-install it
 * on locale change (main re-calls `installAppMenu` on `did-finish-load`) so the
 * menu re-localizes without a restart.
 */
"use strict";

const { isStoreBuild } = require("./store-build");

/**
 * Build and install the application menu.
 * @param {object} deps
 * @param {Electron.App} deps.app
 * @param {typeof Electron.Menu} deps.Menu
 * @param {(key: string, fallback: string) => string} deps.label
 * @param {object} deps.actions  click handlers (see main.js)
 * @param {Array<{id: string, name: string}>} [deps.groups]  tunnel groups for the
 *        per-group arm-all/disarm-all submenus (Feature 140)
 * @param {boolean} [deps.isDev]  include reload / DevTools items
 */
function installAppMenu({
  app,
  Menu,
  label,
  actions,
  groups = [],
  isDev = false,
}) {
  const isMac = process.platform === "darwin";
  const a = actions || {};

  // Per-group arm-all / disarm-all submenus (Feature 140). A "Groups" submenu
  // under File holds one submenu per group; member ids are resolved live in main
  // when a leaf is clicked, so only id + name are needed here.
  const groupList = Array.isArray(groups) ? groups : [];
  const groupItems = groupList.length
    ? [
        { type: "separator" },
        {
          label: label("menu.groups", "Groups"),
          submenu: groupList.map((g) => ({
            label: g.name || label("group.ungrouped", "Ungrouped"),
            submenu: [
              {
                label: label("menu.group.armAll", "Arm All"),
                click: () => a.armGroup?.(g.id),
              },
              {
                label: label("menu.group.disarmAll", "Disarm All"),
                click: () => a.disarmGroup?.(g.id),
              },
            ],
          })),
        },
      ]
    : [];

  // Standard View menu (the app is now a single master-detail surface, so there
  // are no Definition/Monitoring view-switch items).
  const viewItems = [
    ...(isDev
      ? [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ]
      : []),
    // Font-size zoom. The accelerators are advertised only
    // (registerAccelerator:false): the renderer owns the keystroke — it also
    // handles wheel/pinch and lets the combo pass through inside text fields — so
    // the menu must not bind it or the keypress would fire twice.
    {
      label: label("menu.fontIncrease", "Increase Font Size"),
      accelerator: "CmdOrCtrl+Plus",
      registerAccelerator: false,
      click: () => a.fontChange?.("in"),
    },
    {
      label: label("menu.fontDecrease", "Decrease Font Size"),
      accelerator: "CmdOrCtrl+-",
      registerAccelerator: false,
      click: () => a.fontChange?.("out"),
    },
    {
      label: label("menu.fontReset", "Reset Font Size"),
      accelerator: "CmdOrCtrl+0",
      registerAccelerator: false,
      click: () => a.fontChange?.("reset"),
    },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  const helpItems = [
    {
      label: label("menu.userGuide", "Jump Hippo User Guide"),
      click: () => a.userGuide?.(),
    },
    { type: "separator" },
    {
      label: label("menu.copyDiagnostics", "Copy Diagnostics"),
      click: () => a.copyDiagnostics?.(),
    },
    {
      label: label("menu.showLogs", "Show Logs Folder"),
      click: () => a.showLogs?.(),
    },
    // Omitted in store builds: the App Store / Microsoft Store deliver their
    // own updates and the in-app updater is disabled (see store-build.js).
    ...(isStoreBuild()
      ? []
      : [
          { type: "separator" },
          {
            label: label("menu.checkUpdates", "Check for Updates…"),
            click: () => a.checkUpdates?.(),
          },
        ]),
    ...(isMac
      ? []
      : [
          { type: "separator" },
          {
            label: label("menu.about", "About Jump Hippo"),
            click: () => a.about?.(),
          },
        ]),
  ];

  const template = [
    // macOS application menu (Jump Hippo ▸ About / Settings / Hide / Quit).
    ...(isMac
      ? [
          {
            label: app.name || "Jump Hippo",
            submenu: [
              {
                label: label("menu.about", "About Jump Hippo"),
                click: () => a.about?.(),
              },
              { type: "separator" },
              {
                label: label("menu.settings", "Settings…"),
                accelerator: "Cmd+,",
                click: () => a.openSettings?.(),
              },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: label("menu.hide", "Hide Jump Hippo") },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              {
                label: label("menu.quit", "Quit Jump Hippo"),
                accelerator: "Cmd+Q",
                click: () => a.quit?.(),
              },
            ],
          },
        ]
      : []),

    {
      label: label("menu.file", "File"),
      submenu: [
        {
          label: label("menu.newTunnel", "New Tunnel"),
          accelerator: "CmdOrCtrl+N",
          click: () => a.newTunnel?.(),
        },
        {
          label: label("menu.newConsole", "New Console"),
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => a.newConsole?.(),
        },
        { type: "separator" },
        {
          label: label("menu.armAll", "Arm All Tunnels"),
          click: () => a.armAll?.(),
        },
        {
          label: label("menu.disarmAll", "Disarm All Tunnels"),
          click: () => a.disarmAll?.(),
        },
        ...groupItems,
        // On non-mac, Settings + Quit live in the File menu.
        ...(isMac
          ? [{ role: "close" }]
          : [
              { type: "separator" },
              {
                label: label("menu.settings", "Settings…"),
                accelerator: "Ctrl+,",
                click: () => a.openSettings?.(),
              },
              { type: "separator" },
              {
                label: label("menu.quit", "Quit Jump Hippo"),
                accelerator: "Ctrl+Q",
                click: () => a.quit?.(),
              },
            ]),
      ],
    },

    {
      label: label("menu.edit", "Edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },

    { label: label("menu.view", "View"), submenu: viewItems },

    {
      label: label("menu.window", "Window"),
      role: "window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },

    { label: label("menu.help", "Help"), role: "help", submenu: helpItems },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { installAppMenu };
