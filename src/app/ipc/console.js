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
 * ipc/console.js — console IPC handlers (consoles:*), Feature 200.
 *
 * Two families over the request/response bridge:
 *   - Store CRUD (list/get/create/update/delete/reorder) → the ConsoleStore, using
 *     the same safeCall (quiet read) / safeCallWrite (discriminable `{ __hippoError
 *     }` envelope carrying `.code`/`.errors`) discipline as ipc/store.js.
 *   - Session control (open/close/sessions) → the ConsoleManager. `open` mints a
 *     session + terminal window; the interactive byte stream then flows over the
 *     separate one-way `console:*` `send`/`on` channels (main.js), NOT here.
 *
 * Every channel registered here MUST have a matching `window.jumphippo.*` exposure
 * in preload.js — the ipc-parity test (with ipc/console.js in its scan list) fails
 * the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => import('../store/stores').Stores} deps.getStores
 * @param {() => import('../console/console-manager').ConsoleManager} deps.getConsoleManager
 * @param {(channel: string, fn: Function, fallback?: any) => any} deps.safeCall
 * @param {(channel: string, fn: Function) => any} deps.safeCallWrite
 */
function registerConsoleIPC({
  ipcMain,
  getStores,
  getConsoleManager,
  safeCall,
  safeCallWrite,
}) {
  // ── Console definitions (CRUD) ────────────────────────────────────────────────

  ipcMain.handle("consoles:list", () =>
    safeCall("consoles:list", () => getStores().consoleStore().list(), []),
  );

  ipcMain.handle("consoles:get", (_event, id) =>
    safeCall("consoles:get", () => getStores().consoleStore().get(id), null),
  );

  ipcMain.handle("consoles:create", (_event, def) =>
    safeCallWrite("consoles:create", () =>
      getStores().consoleStore().create(def),
    ),
  );

  ipcMain.handle("consoles:update", (_event, id, patch) =>
    safeCallWrite("consoles:update", () =>
      getStores().consoleStore().update(id, patch),
    ),
  );

  ipcMain.handle("consoles:delete", (_event, id) =>
    safeCallWrite("consoles:delete", () =>
      getStores().consoleStore().delete(id),
    ),
  );

  ipcMain.handle("consoles:reorder", (_event, ids) =>
    safeCallWrite("consoles:reorder", () =>
      getStores().consoleStore().reorder(ids),
    ),
  );

  // ── Session control ───────────────────────────────────────────────────────────

  // Open a console: mint a session + terminal window (SSH connect is deferred to
  // the window's `console:ready`). Returns `{ sessionId, id }`, or a `{ __hippoError
  // }` envelope (e.g. NOT_FOUND) the renderer can surface.
  ipcMain.handle("consoles:open", (_event, id) =>
    safeCallWrite("consoles:open", () => getConsoleManager()?.open(id)),
  );

  // Close an open session by id (also happens automatically when its window closes).
  ipcMain.handle("consoles:close", (_event, sessionId) =>
    safeCall("consoles:close", () => {
      getConsoleManager()?.close(sessionId);
      return { ok: true };
    }),
  );

  // Snapshot of the currently-open sessions (id + sessionId + state) for the
  // sidebar row lamps on (re)load. Live changes arrive over jumphippo:console-state.
  ipcMain.handle("consoles:sessions", () =>
    safeCall(
      "consoles:sessions",
      () => getConsoleManager()?.sessions() ?? [],
      [],
    ),
  );
}

module.exports = { registerConsoleIPC };
