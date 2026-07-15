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

// updater.js — Auto-update integration (Feature 70).
//
// Wraps electron-updater's autoUpdater: checks the GitHub Releases feed on
// startup (debounced) and on demand, downloads a newer build in the background,
// and lets the renderer prompt the user to restart-and-install. Every update
// lifecycle event is forwarded to the renderer as an `updater:*` push channel
// (preload.js mirrors each into a `porthippo:update-*` DOM event); the renderer
// owns the user-facing toasts and the Settings → About status line. We never
// restart without consent: a downloaded update installs only on a normal quit
// (autoInstallOnAppQuit) or an explicit, user-confirmed quitAndInstall().
//
// The update check is the ONLY outbound call this module makes — no telemetry.
"use strict";

// Electron's `app` and electron-updater's `autoUpdater` are resolved LAZILY, and
// through overridable refs. Accessing either eagerly constructs the platform
// updater / dereferences Electron natives that are absent under the Node test
// runner — deferring keeps `require("./updater")` (and thus `require("./main")`)
// inert in tests, where main.js loads but app.whenReady() never resolves. Tests
// inject fakes via _setTestHooks (mirroring crypto._setSafeStorage).
let _autoUpdater = null;
let _app = null;

function getAutoUpdater() {
  return _autoUpdater || require("electron-updater").autoUpdater;
}

function getApp() {
  return _app || require("electron").app;
}

// Window accessor + logger are injected by initUpdater() so this module never
// requires main.js (which requires it — that would be a cycle).
let _getWindow = () => null;

// Whether the in-flight check was user-initiated. electron-updater's events
// carry no caller context, so we capture it when a check starts and thread it
// into each push payload: the renderer suppresses the "up to date" / error
// toasts for silent startup checks (manual === false) and shows them for
// explicit ones. Checks are effectively sequential, so a single flag suffices.
let _manual = false;

let _wired = false;

// Push an updater event to the renderer window, if one is alive.
function pushUpdaterEvent(channel, payload) {
  const win = _getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/**
 * Wire autoUpdater once and remember how to reach the renderer window. Safe to
 * call repeatedly — only the first call attaches listeners.
 *
 * @param {() => (import("electron").BrowserWindow | null)} getWindow
 * @param {{ info: Function, warn: Function, error: Function, debug?: Function }} [logger]
 */
function initUpdater(getWindow, logger) {
  if (getWindow) _getWindow = getWindow;
  if (_wired) return;
  _wired = true;

  const autoUpdater = getAutoUpdater();

  // Download automatically when an update is found; install only on quit or an
  // explicit quitAndInstall() — never a forced restart. Stable releases only.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  // Route electron-updater's own logging into the app log (if a logger is wired,
  // Feature 60) so update failures are recoverable from a bug report.
  if (logger) {
    const at = (level) => (msg) => {
      const fn = logger[level] || logger.info;
      fn("updater", String(msg && msg.stack ? msg.stack : msg));
    };
    autoUpdater.logger = {
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      debug: at("debug"),
    };
  }

  autoUpdater.on("checking-for-update", () =>
    pushUpdaterEvent("updater:checking", { manual: _manual }),
  );
  autoUpdater.on("update-available", (info) =>
    pushUpdaterEvent("updater:available", {
      version: info?.version,
      manual: _manual,
    }),
  );
  autoUpdater.on("update-not-available", () =>
    pushUpdaterEvent("updater:not-available", { manual: _manual }),
  );
  autoUpdater.on("download-progress", (p) =>
    pushUpdaterEvent("updater:progress", {
      percent: p?.percent ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    pushUpdaterEvent("updater:downloaded", { version: info?.version }),
  );
  autoUpdater.on("error", (err) =>
    pushUpdaterEvent("updater:error", {
      message: (err && err.message) || String(err),
      manual: _manual,
    }),
  );
}

/**
 * Check for updates. An unpacked/dev build cannot self-update (electron-updater
 * throws), so short-circuit with a "dev build" not-available instead — the
 * Settings panel reports it honestly rather than erroring.
 *
 * (Mac App Store / Microsoft Store builds are deferred to a later feature; when
 * they land, this is where a store-build short-circuit would go.)
 *
 * @param {{ manual?: boolean }} [opts]
 */
function checkForUpdates({ manual = false } = {}) {
  _manual = !!manual;
  if (!getApp().isPackaged) {
    pushUpdaterEvent("updater:not-available", {
      manual: _manual,
      reason: "dev-build",
    });
    return;
  }
  // checkForUpdates() rejects on network/signature failures, but the "error"
  // event has already fired with the same cause — swallow the rejection so it
  // doesn't surface as an unhandled promise rejection.
  Promise.resolve(getAutoUpdater().checkForUpdates()).catch(() => {});
}

/**
 * Quit and install a downloaded update. User-confirmed only (wired to the
 * "Restart" toast action / Settings button). No-op if nothing is downloaded.
 */
function quitAndInstall() {
  try {
    // isSilent=false → show the installer UI (Windows); isForceRunAfter=true →
    // relaunch the app once the update is applied.
    getAutoUpdater().quitAndInstall(false, true);
  } catch {
    /* nothing downloaded yet / not packaged — nothing to do */
  }
}

// Test seam (mirrors crypto._setSafeStorage): inject a fake `app` + `autoUpdater`
// and reset the one-shot wiring guard so the update lifecycle can be driven without
// Electron. Call with no args to restore the real (lazy) modules.
function _setTestHooks({ app = null, autoUpdater = null } = {}) {
  _app = app;
  _autoUpdater = autoUpdater;
  _wired = false;
  _getWindow = () => null;
  _manual = false;
}

module.exports = {
  initUpdater,
  checkForUpdates,
  quitAndInstall,
  _setTestHooks,
};
