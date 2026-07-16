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
 * ipc/engine.js — SSH tunnel engine IPC handlers.
 *
 * The renderer only ever sends *intents* over these channels — arm/disarm a
 * definition, pause/resume it, ask for a status snapshot, or answer a host-key
 * trust prompt. All sockets and SSH live in the engine (main). Live state flows
 * the other way as `porthippo:tunnel-state` /
 * `porthippo:stats` / `porthippo:hostkey-*` broadcasts (see main.js), not through
 * these request/response channels.
 *
 * Engine calls are async, so each handler is wrapped to await the result and turn a
 * failure into the same discriminable `{ __hippoError }` envelope the store IPC uses.
 *
 * Every channel registered here MUST have a matching `window.porthippo.*` exposure
 * in preload.js — the ipc-parity test fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {() => import('../tunnel/engine').TunnelEngine} deps.getEngine
 */
const { wrap } = require("./wrap");

function registerEngineIPC({ ipcMain, getEngine }) {
  // ── Arm / disarm / status ─────────────────────────────────────────────────────

  ipcMain.handle(
    "tunnels:arm",
    wrap("tunnels:arm", (id) => getEngine().arm(id)),
  );
  ipcMain.handle(
    "tunnels:disarm",
    wrap("tunnels:disarm", (id) => getEngine().disarm(id)),
  );
  ipcMain.handle(
    "tunnels:status",
    wrap("tunnels:status", () => getEngine().status()),
  );

  // On-demand error/warning history for one tunnel (the "Errors" card dialog).
  ipcMain.handle(
    "tunnels:events",
    wrap("tunnels:events", (id) => getEngine().events(id)),
  );

  // Force-apply a pending (connection-affecting) edit now, dropping live
  // connections, instead of waiting for the tunnel to go idle.
  ipcMain.handle(
    "tunnels:apply",
    wrap("tunnels:apply", (id) => getEngine().apply(id)),
  );

  // Pause / resume: freeze (or restore) traffic without touching SSH or the store.
  ipcMain.handle(
    "tunnels:pause",
    wrap("tunnels:pause", (id) => getEngine().pause(id)),
  );
  ipcMain.handle(
    "tunnels:resume",
    wrap("tunnels:resume", (id) => getEngine().resume(id)),
  );

  // Bulk action over a set of ids (Feature 140 — group arm-all / multi-select bulk
  // bar). One coalesced state broadcast for the whole set, not one per tunnel.
  ipcMain.handle(
    "tunnels:apply-many",
    wrap("tunnels:apply-many", (payload) =>
      getEngine().applyToMany(payload?.ids, payload?.action),
    ),
  );

  // ── Host-key trust decisions (resolve a pending TOFU prompt) ──────────────────

  ipcMain.handle(
    "hostkeys:trust",
    wrap("hostkeys:trust", (promptId) => getEngine().trustHostKey(promptId)),
  );
  ipcMain.handle(
    "hostkeys:reject",
    wrap("hostkeys:reject", (promptId) => getEngine().rejectHostKey(promptId)),
  );
}

module.exports = { registerEngineIPC };
