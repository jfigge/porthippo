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
 * platform-localized labels; only Port Hippo's custom items are labelled through
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

/**
 * Build and install the application menu.
 * @param {object} deps
 * @param {Electron.App} deps.app
 * @param {typeof Electron.Menu} deps.Menu
 * @param {(key: string, fallback: string) => string} deps.label
 * @param {object} deps.actions  click handlers (see main.js)
 * @param {boolean} [deps.isDev]  include reload / DevTools items
 */
function installAppMenu({ app, Menu, label, actions, isDev = false }) {
  const isMac = process.platform === "darwin";
  const a = actions || {};

  // View-switch items shared by macOS + other platforms.
  const viewItems = [
    {
      label: label("menu.viewDefinition", "Definition"),
      accelerator: "CmdOrCtrl+1",
      click: () => a.setView?.("definition"),
    },
    {
      label: label("menu.viewMonitoring", "Monitoring"),
      accelerator: "CmdOrCtrl+2",
      click: () => a.setView?.("monitoring"),
    },
    { type: "separator" },
    ...(isDev
      ? [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ]
      : []),
    { role: "togglefullscreen" },
  ];

  const helpItems = [
    {
      label: label("menu.copyDiagnostics", "Copy Diagnostics"),
      click: () => a.copyDiagnostics?.(),
    },
    {
      label: label("menu.showLogs", "Show Logs Folder"),
      click: () => a.showLogs?.(),
    },
    { type: "separator" },
    {
      label: label("menu.checkUpdates", "Check for Updates…"),
      click: () => a.checkUpdates?.(),
    },
    ...(isMac
      ? []
      : [
          { type: "separator" },
          {
            label: label("menu.about", "About Port Hippo"),
            click: () => a.about?.(),
          },
        ]),
  ];

  const template = [
    // macOS application menu (Port Hippo ▸ About / Settings / Hide / Quit).
    ...(isMac
      ? [
          {
            label: app.name || "Port Hippo",
            submenu: [
              {
                label: label("menu.about", "About Port Hippo"),
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
              { role: "hide", label: label("menu.hide", "Hide Port Hippo") },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              {
                label: label("menu.quit", "Quit Port Hippo"),
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
        { type: "separator" },
        {
          label: label("menu.armAll", "Arm All Tunnels"),
          click: () => a.armAll?.(),
        },
        {
          label: label("menu.disarmAll", "Disarm All Tunnels"),
          click: () => a.disarmAll?.(),
        },
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
                label: label("menu.quit", "Quit Port Hippo"),
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
