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
 * ipc/shell.js — Feature 60 app-shell IPC (i18n catalog + diagnostics).
 *
 * The renderer awaits `i18n:load` once at startup to layer the active locale's
 * catalog over its embedded English, and calls `diagnostics:copy` to place the
 * redacted diagnostics report on the clipboard (the same report the Help/tray
 * "Copy Diagnostics" action produces). Both are thin, injected thunks so this
 * module stays pure delegation and never imports Electron (matching ipc/store.js
 * and ipc/engine.js).
 *
 * Every channel registered here MUST have a matching `window.porthippo.*`
 * exposure in preload.js AND this file must be listed in the ipc-parity test's
 * scan set (tests/ipc-parity.test.js) — the guard fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {(channel: string, fn: Function, fallback?: any) => any} deps.safeCall
 * @param {() => object} deps.loadCatalog  resolve the active i18n catalog
 * @param {() => string} deps.copyDiagnostics  build the report, copy it, return it
 */
function registerShellIPC({ ipcMain, safeCall, loadCatalog, copyDiagnostics }) {
  ipcMain.handle("i18n:load", () =>
    safeCall("i18n:load", () => loadCatalog(), null),
  );

  ipcMain.handle("diagnostics:copy", () =>
    safeCall("diagnostics:copy", () => copyDiagnostics(), ""),
  );
}

module.exports = { registerShellIPC };
