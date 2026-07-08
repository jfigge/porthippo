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
 * ipc/store.js — storage IPC handlers (tunnels:* / settings:* / hostkeys:*).
 *
 * Pure delegation to the store modules behind the injected `getStores()`. Reads
 * use safeCall (quiet: log + look-alike fallback); authoritative writes use
 * safeCallWrite (a failure returns a discriminable `{ __hippoError }` envelope the
 * renderer can surface — carrying `.code`/`.errors` so a validation failure lands
 * as field-keyed messages, not a generic toast).
 *
 * Every channel registered here MUST have a matching `window.porthippo.*` exposure
 * in preload.js — the ipc-parity test fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => import('../store/stores').Stores} deps.getStores
 * @param {(channel: string, fn: Function, fallback?: any) => any} deps.safeCall
 * @param {(channel: string, fn: Function) => any} deps.safeCallWrite
 */
function registerStoreIPC({ ipcMain, getStores, safeCall, safeCallWrite }) {
  // ── Tunnel definitions ──────────────────────────────────────────────────────

  ipcMain.handle("tunnels:list", () =>
    safeCall("tunnels:list", () => getStores().tunnelStore().list(), []),
  );

  ipcMain.handle("tunnels:get", (_event, id) =>
    safeCall("tunnels:get", () => getStores().tunnelStore().get(id), null),
  );

  ipcMain.handle("tunnels:create", (_event, def) =>
    safeCallWrite("tunnels:create", () =>
      getStores().tunnelStore().create(def),
    ),
  );

  ipcMain.handle("tunnels:update", (_event, id, patch) =>
    safeCallWrite("tunnels:update", () =>
      getStores().tunnelStore().update(id, patch),
    ),
  );

  ipcMain.handle("tunnels:delete", (_event, id) =>
    safeCallWrite("tunnels:delete", () => getStores().tunnelStore().delete(id)),
  );

  ipcMain.handle("tunnels:reorder", (_event, ids) =>
    safeCallWrite("tunnels:reorder", () =>
      getStores().tunnelStore().reorder(ids),
    ),
  );

  // ── App settings ────────────────────────────────────────────────────────────

  ipcMain.handle("settings:get", () =>
    safeCall("settings:get", () => getStores().settingsStore().get(), {}),
  );

  ipcMain.handle("settings:set", (_event, patch) =>
    safeCallWrite("settings:set", () => getStores().settingsStore().set(patch)),
  );

  // ── Accepted SSH host keys (TOFU) ───────────────────────────────────────────

  ipcMain.handle("hostkeys:list", () =>
    safeCall("hostkeys:list", () => getStores().knownHostsStore().list(), []),
  );

  ipcMain.handle("hostkeys:revoke", (_event, hostPort) =>
    safeCallWrite("hostkeys:revoke", () =>
      getStores().knownHostsStore().revoke(hostPort),
    ),
  );
}

module.exports = { registerStoreIPC };
