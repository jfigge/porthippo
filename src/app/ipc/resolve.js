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
 * ipc/resolve.js — hostname-resolution validation IPC (Feature 100).
 *
 * Intents from the editor, all request/response:
 *   - `resolve:lookup` — does a single host resolve *from this machine*? (the live
 *     first-hop / target-server warnings). Pure DNS, no connection.
 *   - `resolve:bindcheck` — does a host resolve *and* name an address this machine
 *     can bind (loopback / wildcard / a local interface)? Drives the Entry-port
 *     not-a-local-address warning. Pure DNS + interface enumeration, no connection.
 *   - `resolve:test` — walk the real jump chain and probe the destination from the
 *     far end, reporting a per-hop result. This decrypts the referenced credentials
 *     in main (`tunnelStore().resolveDecrypted`) and hands the engine-shaped def to
 *     the engine's disposable probe; only host/port/status/reason cross back — never
 *     a secret. An unknown host key surfaces over the existing
 *     `porthippo:hostkey-unknown` broadcast + `hostkeys:trust|reject`, not here.
 *   - `resolve:cancel` — abort the in-flight `resolve:test`.
 *
 * Only one probe runs at a time: a fresh `resolve:test` supersedes (aborts) any prior
 * run, so a user hammering the button can't stack live SSH connections.
 *
 * Every channel registered here MUST have a matching `window.porthippo.*` exposure in
 * preload.js — the ipc-parity test (which scans this file) fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => import('../store/stores').Stores} deps.getStores
 * @param {() => import('../tunnel/engine').TunnelEngine} deps.getEngine
 */
const { lookupHost, classifyBindHost } = require("../tunnel/resolve-check");
const { wrap } = require("./wrap");

function registerResolveIPC({ ipcMain, getStores, getEngine }) {
  let active = null; // the in-flight probe's AbortController, or null

  ipcMain.handle(
    "resolve:lookup",
    wrap("resolve:lookup", ({ host } = {}) => lookupHost(host)),
  );

  ipcMain.handle(
    "resolve:bindcheck",
    wrap("resolve:bindcheck", ({ host } = {}) => classifyBindHost(host)),
  );

  ipcMain.handle(
    "resolve:test",
    wrap("resolve:test", async ({ payload } = {}) => {
      if (active) active.abort(); // a new run supersedes the previous one
      const controller = new AbortController();
      active = controller;
      try {
        const def = getStores().tunnelStore().resolveDecrypted(payload);
        return await getEngine().probeDefinition(def, {
          signal: controller.signal,
        });
      } finally {
        if (active === controller) active = null;
      }
    }),
  );

  ipcMain.handle(
    "resolve:cancel",
    wrap("resolve:cancel", () => {
      if (active) {
        active.abort();
        active = null;
      }
      return { ok: true };
    }),
  );
}

module.exports = { registerResolveIPC };
