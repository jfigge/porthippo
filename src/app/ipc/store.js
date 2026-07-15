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
 * ipc/store.js — storage IPC handlers (tunnels:* / credentials:* / jumphosts:* /
 * settings:*).
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
 * @param {(id: string) => void} [deps.afterWrite]  notified with the affected id
 *        after a successful definition create/update/delete so the Feature 20 engine
 *        can reconcile the running tunnel.
 * @param {() => void} [deps.afterRefsWrite]  notified after a successful credential
 *        / jump-host write so the engine can reconcile every tunnel that resolves
 *        through the changed record.
 * @param {(settings: object) => void} [deps.afterSettingsWrite]  notified with the
 *        merged settings after a successful settings:set so main can apply platform
 *        side-effects (Feature 60 launch-at-login).
 */
function registerStoreIPC({
  ipcMain,
  getStores,
  safeCall,
  safeCallWrite,
  afterWrite,
  afterRefsWrite,
  afterSettingsWrite,
}) {
  // Fire the reconcile hook only after a write that actually succeeded.
  const notify = (result, id) => {
    if (result && !result.__hippoError && id) afterWrite?.(id);
    return result;
  };

  // A credential / jump-host write can change the resolved plan of many tunnels,
  // so reconcile broadly (never scoped to one id) after a successful write.
  const notifyRefs = (result) => {
    if (result && !result.__hippoError) afterRefsWrite?.();
    return result;
  };

  // ── Tunnel definitions ──────────────────────────────────────────────────────

  ipcMain.handle("tunnels:list", () =>
    safeCall("tunnels:list", () => getStores().tunnelStore().list(), []),
  );

  ipcMain.handle("tunnels:get", (_event, id) =>
    safeCall("tunnels:get", () => getStores().tunnelStore().get(id), null),
  );

  ipcMain.handle("tunnels:create", (_event, def) => {
    const result = safeCallWrite("tunnels:create", () =>
      getStores().tunnelStore().create(def),
    );
    return notify(result, result && result.id);
  });

  ipcMain.handle("tunnels:update", (_event, id, patch) => {
    const result = safeCallWrite("tunnels:update", () =>
      getStores().tunnelStore().update(id, patch),
    );
    return notify(result, id);
  });

  ipcMain.handle("tunnels:delete", (_event, id) => {
    const result = safeCallWrite("tunnels:delete", () =>
      getStores().tunnelStore().delete(id),
    );
    return notify(result, id);
  });

  // ── Reusable credentials (Feature 45) ───────────────────────────────────────

  ipcMain.handle("credentials:list", () =>
    safeCall(
      "credentials:list",
      () => getStores().credentialStore().list(),
      [],
    ),
  );

  ipcMain.handle("credentials:get", (_event, id) =>
    safeCall(
      "credentials:get",
      () => getStores().credentialStore().get(id),
      null,
    ),
  );

  ipcMain.handle("credentials:create", (_event, cred) =>
    notifyRefs(
      safeCallWrite("credentials:create", () =>
        getStores().credentialStore().create(cred),
      ),
    ),
  );

  ipcMain.handle("credentials:update", (_event, id, patch) =>
    notifyRefs(
      safeCallWrite("credentials:update", () =>
        getStores().credentialStore().update(id, patch),
      ),
    ),
  );

  ipcMain.handle("credentials:delete", (_event, id) =>
    notifyRefs(
      safeCallWrite("credentials:delete", () =>
        getStores().credentialStore().delete(id),
      ),
    ),
  );

  // ── Reusable jump hosts (Feature 45) ────────────────────────────────────────

  ipcMain.handle("jumphosts:list", () =>
    safeCall("jumphosts:list", () => getStores().jumpHostStore().list(), []),
  );

  ipcMain.handle("jumphosts:get", (_event, id) =>
    safeCall("jumphosts:get", () => getStores().jumpHostStore().get(id), null),
  );

  ipcMain.handle("jumphosts:create", (_event, jump) =>
    notifyRefs(
      safeCallWrite("jumphosts:create", () =>
        getStores().jumpHostStore().create(jump),
      ),
    ),
  );

  ipcMain.handle("jumphosts:update", (_event, id, patch) =>
    notifyRefs(
      safeCallWrite("jumphosts:update", () =>
        getStores().jumpHostStore().update(id, patch),
      ),
    ),
  );

  ipcMain.handle("jumphosts:delete", (_event, id) =>
    notifyRefs(
      safeCallWrite("jumphosts:delete", () =>
        getStores().jumpHostStore().delete(id),
      ),
    ),
  );

  // ── Accepted SSH host keys (TOFU) ─────────────────────────────────────────────
  // The trust/reject *prompt* answers live in ipc/engine.js; these two manage the
  // persisted accepted-key store surfaced in Settings → Host Keys. Revoking only
  // affects the NEXT handshake — a live connection keeps its socket until it next
  // drops — so there is no engine reconcile hook here.

  ipcMain.handle("hostkeys:list", () =>
    safeCall("hostkeys:list", () => getStores().knownHostsStore().list(), []),
  );

  ipcMain.handle("hostkeys:revoke", (_event, hostPort) =>
    safeCallWrite("hostkeys:revoke", () =>
      getStores().knownHostsStore().revoke(hostPort),
    ),
  );

  // ── App settings ────────────────────────────────────────────────────────────

  ipcMain.handle("settings:get", () =>
    safeCall("settings:get", () => getStores().settingsStore().get(), {}),
  );

  ipcMain.handle("settings:set", (_event, patch) => {
    const result = safeCallWrite("settings:set", () =>
      getStores().settingsStore().set(patch),
    );
    if (result && !result.__hippoError) afterSettingsWrite?.(result);
    return result;
  });
}

module.exports = { registerStoreIPC };
