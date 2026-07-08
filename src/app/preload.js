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

// preload.js — runs in the renderer before page content loads and exposes the
// single, narrow window.porthippo bridge. Every later feature extends THIS
// object (tunnels.*, settings.*, stats, …) and must keep it in lockstep with the
// ipcMain handlers in main.js.
//
// SANDBOX RESTRICTION: this runs in Electron's sandboxed renderer, where
// require() is limited to Electron built-ins ONLY. Never require("../anything")
// here — it crashes the preload in packaged (.asar) builds. Anything from the
// main process must arrive over IPC.
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("porthippo", {
  // Static platform info — available synchronously from the sandboxed preload's
  // process shim, so no IPC round-trip is needed.
  platform: process.platform,
  arch: process.arch,

  // App version comes from the main process (package.json), over IPC — this also
  // proves the ipcMain <-> preload bridge is wired correctly.
  getVersion: () => ipcRenderer.invoke("app:version"),

  // ── Tunnel definitions (Feature 10 store) ─────────────────────────────────
  // CRUD + reorder over the encrypted-at-rest store. Reads return secrets as a
  // `hasSecret` flag only; a create/update writes a NEW secret as a plaintext
  // string or keeps an existing one by sending the auth entry back with
  // `hasSecret: true` and no value. Writes resolve to the record, or to a
  // `{ __hippoError, code, errors }` envelope on failure.
  tunnels: {
    list: () => ipcRenderer.invoke("tunnels:list"),
    get: (id) => ipcRenderer.invoke("tunnels:get", id),
    create: (def) => ipcRenderer.invoke("tunnels:create", def),
    update: (id, patch) => ipcRenderer.invoke("tunnels:update", id, patch),
    delete: (id) => ipcRenderer.invoke("tunnels:delete", id),
    reorder: (ids) => ipcRenderer.invoke("tunnels:reorder", ids),

    // ── Engine intents (Feature 20) ─────────────────────────────────────────
    // The renderer only sends intents; live state arrives via the
    // `porthippo:tunnel-state` event below. Arm binds the local listener (SSH is
    // opened lazily on first access); `apply` force-applies a pending edit,
    // dropping live connections.
    arm: (id) => ipcRenderer.invoke("tunnels:arm", id),
    disarm: (id) => ipcRenderer.invoke("tunnels:disarm", id),
    status: () => ipcRenderer.invoke("tunnels:status"),
    apply: (id) => ipcRenderer.invoke("tunnels:apply", id),
  },

  // ── App settings ──────────────────────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },

  // ── Accepted SSH host keys (TOFU) ─────────────────────────────────────────
  // The engine (Feature 20) records accepted keys in-process; the renderer can
  // review the accepted set and revoke entries.
  hostkeys: {
    list: () => ipcRenderer.invoke("hostkeys:list"),
    revoke: (hostPort) => ipcRenderer.invoke("hostkeys:revoke", hostPort),

    // Resolve an unknown-host-key prompt raised during a connection (TOFU). The
    // engine holds the connection pending until one of these is called.
    trust: (promptId) => ipcRenderer.invoke("hostkeys:trust", promptId),
    reject: (promptId) => ipcRenderer.invoke("hostkeys:reject", promptId),
  },

  // ── Auto-update (Feature 70) ──────────────────────────────────────────────
  // Trigger a manual update check or a restart-and-install. Update *lifecycle*
  // events arrive as porthippo:update-* CustomEvents on window (wired below),
  // not through this object.
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    quitAndInstall: () => ipcRenderer.invoke("updater:quit-and-install"),
  },
});

// ── Main → renderer push events ───────────────────────────────────────────────
// The engine pushes live state one-way over these channels. We re-dispatch each as
// a global `porthippo:*` CustomEvent (matching the renderer's app-wide event
// convention) so any panel can `window.addEventListener(...)`. Only the serializable
// payload crosses; the raw Electron event is stripped. Payloads carry fingerprints
// only — never secrets or key material.
for (const channel of [
  "porthippo:tunnel-state",
  "porthippo:hostkey-unknown",
  "porthippo:hostkey-changed",
]) {
  ipcRenderer.on(channel, (_event, detail) => {
    window.dispatchEvent(new CustomEvent(channel, { detail }));
  });
}

// ── Auto-update lifecycle events (Feature 70) ───────────────────────────────
// Mirror each main→renderer updater:* push onto the window as a global
// porthippo:update-* CustomEvent, following the project's one-way broadcast
// convention. Payloads are plain serializable objects (version / progress /
// error message) — never secrets.
const UPDATER_EVENT_MAP = {
  "updater:checking": "porthippo:update-checking",
  "updater:available": "porthippo:update-available",
  "updater:not-available": "porthippo:update-not-available",
  "updater:progress": "porthippo:update-progress",
  "updater:downloaded": "porthippo:update-downloaded",
  "updater:error": "porthippo:update-error",
};
for (const [channel, domEvent] of Object.entries(UPDATER_EVENT_MAP)) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(domEvent, { detail: payload }));
  });
}
