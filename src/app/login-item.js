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
 * login-item.js — "launch at login" across platforms.
 *
 * macOS/Windows use Electron's native `app.setLoginItemSettings` (which also
 * honours `openAsHidden` so a login launch can start straight into the tray).
 * Linux has no such API, so we manage a freedesktop autostart entry ourselves
 * (`~/.config/autostart/porthippo.desktop`).
 *
 * Every collaborator (the Electron `app`, the platform, the home directory, and
 * `fs`) is injected so the module is unit-testable without a running Electron
 * process. Operations never throw — a failure is logged and swallowed so a
 * misbehaving OS integration can't take the app down.
 */
"use strict";

const path = require("path");

const APP_ID = "porthippo";

/**
 * @param {object} deps
 * @param {Electron.App} [deps.app]         Electron app (mac/win backend)
 * @param {string} [deps.platform]          process.platform override (tests)
 * @param {string} [deps.appName]           display name for the .desktop entry
 * @param {string} [deps.exePath]           executable to launch (prod: execPath)
 * @param {() => string} [deps.homedir]     home-dir resolver (Linux autostart)
 * @param {typeof import('fs')} [deps.fs]   filesystem (injected for tests)
 * @param {(...a:any[]) => void} [deps.onError]  error sink (defaults to console)
 */
function createLoginItem({
  app,
  platform = process.platform,
  appName = "Port Hippo",
  exePath = process.execPath,
  homedir = require("os").homedir,
  fs = require("fs"),
  onError = (...a) => console.error("[login-item]", ...a),
} = {}) {
  const isLinux = platform === "linux";

  const desktopPath = () =>
    path.join(homedir(), ".config", "autostart", `${APP_ID}.desktop`);

  const desktopEntry = () =>
    [
      "[Desktop Entry]",
      "Type=Application",
      `Name=${appName}`,
      `Exec=${exePath}`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      `Comment=Start ${appName} at login`,
      "",
    ].join("\n");

  return {
    /** Whether launch-at-login is currently enabled. */
    isEnabled() {
      try {
        if (isLinux) return fs.existsSync(desktopPath());
        return Boolean(app.getLoginItemSettings().openAtLogin);
      } catch (err) {
        onError("isEnabled failed:", err && err.message);
        return false;
      }
    },

    /**
     * Enable or disable launch-at-login.
     * @param {boolean} enabled
     * @param {{ openAsHidden?: boolean }} [opts]  start hidden in the tray
     */
    set(enabled, { openAsHidden = false } = {}) {
      try {
        if (isLinux) {
          const file = desktopPath();
          if (enabled) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, desktopEntry(), { mode: 0o644 });
          } else {
            fs.rmSync(file, { force: true });
          }
          return;
        }
        app.setLoginItemSettings({
          openAtLogin: Boolean(enabled),
          openAsHidden,
        });
      } catch (err) {
        onError("set failed:", err && err.message);
      }
    },
  };
}

module.exports = { createLoginItem, APP_ID };
