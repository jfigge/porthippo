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
  // Electron runtime version, shown in the About dialog's build details.
  electron: process.versions?.electron,

  // App version comes from the main process (package.json), over IPC — this also
  // proves the ipcMain <-> preload bridge is wired correctly.
  getVersion: () => ipcRenderer.invoke("app:version"),

  // ── Tunnel definitions (Feature 10 store) ─────────────────────────────────
  // CRUD over the encrypted-at-rest store. Reads return secrets as a `hasSecret`
  // flag only; a create/update writes a NEW secret as a plaintext string or keeps
  // an existing one by sending the auth entry back with `hasSecret: true` and no
  // value. Writes resolve to the record, or to a `{ __hippoError, code, errors }`
  // envelope on failure.
  tunnels: {
    list: () => ipcRenderer.invoke("tunnels:list"),
    get: (id) => ipcRenderer.invoke("tunnels:get", id),
    create: (def) => ipcRenderer.invoke("tunnels:create", def),
    update: (id, patch) => ipcRenderer.invoke("tunnels:update", id, patch),
    delete: (id) => ipcRenderer.invoke("tunnels:delete", id),

    // ── Engine intents (Feature 20) ─────────────────────────────────────────
    // The renderer only sends intents; live state arrives via the
    // `porthippo:tunnel-state` / `porthippo:stats` events below. Arm binds the
    // local listener (SSH is opened lazily on first access); `pause`/`resume`
    // freeze and restore traffic without tearing SSH down or altering the stored
    // definition.
    arm: (id) => ipcRenderer.invoke("tunnels:arm", id),
    disarm: (id) => ipcRenderer.invoke("tunnels:disarm", id),
    status: () => ipcRenderer.invoke("tunnels:status"),
    // On-demand error/warning history for one tunnel (the "Errors" card dialog).
    events: (id) => ipcRenderer.invoke("tunnels:events", id),
    pause: (id) => ipcRenderer.invoke("tunnels:pause", id),
    resume: (id) => ipcRenderer.invoke("tunnels:resume", id),
    // Force-apply a stashed connection-affecting edit now (drops live connections)
    // instead of waiting for the tunnel to go idle.
    apply: (id) => ipcRenderer.invoke("tunnels:apply", id),
  },

  // ── Reusable credentials (Feature 45) ─────────────────────────────────────
  // Named SSH credentials a tunnel / jump host references by id. Reads return
  // the secret as a `hasSecret` flag only; a create/update writes a NEW secret
  // as a plaintext string or keeps an existing one by sending the record back
  // with `hasSecret: true` and no value. Delete resolves to a `{ __hippoError,
  // code: "IN_USE", references }` envelope when the credential is still in use.
  credentials: {
    list: () => ipcRenderer.invoke("credentials:list"),
    get: (id) => ipcRenderer.invoke("credentials:get", id),
    create: (cred) => ipcRenderer.invoke("credentials:create", cred),
    update: (id, patch) => ipcRenderer.invoke("credentials:update", id, patch),
    delete: (id) => ipcRenderer.invoke("credentials:delete", id),
  },

  // ── Reusable jump hosts (Feature 45) ──────────────────────────────────────
  // Named SSH jump hosts (each references a credential); a tunnel holds an
  // ordered list of their ids. Delete is guarded the same way as credentials.
  jumpHosts: {
    list: () => ipcRenderer.invoke("jumphosts:list"),
    get: (id) => ipcRenderer.invoke("jumphosts:get", id),
    create: (jump) => ipcRenderer.invoke("jumphosts:create", jump),
    update: (id, patch) => ipcRenderer.invoke("jumphosts:update", id, patch),
    delete: (id) => ipcRenderer.invoke("jumphosts:delete", id),
  },

  // ── App settings ──────────────────────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },

  // ── Native file pickers (Feature 40) ──────────────────────────────────────
  // The sandboxed renderer can't read a typed path, so the auth editor's Browse
  // asks main to open a native picker; only the chosen path comes back (or null
  // if cancelled) — never file bytes.
  dialog: {
    openKeyFile: () => ipcRenderer.invoke("dialog:open-key-file"),
  },

  // ── Accepted SSH host keys (TOFU) ─────────────────────────────────────────
  // Resolve an unknown-host-key prompt raised during a connection (TOFU). The
  // engine holds the connection pending until one of these is called.
  hostkeys: {
    trust: (promptId) => ipcRenderer.invoke("hostkeys:trust", promptId),
    reject: (promptId) => ipcRenderer.invoke("hostkeys:reject", promptId),
  },

  // ── Hostname-resolution validation (Feature 100) ──────────────────────────
  // The editor asks main whether hosts resolve. `lookup` is a pure local DNS
  // check for the names resolved from this machine (target server / first hop).
  // `bindcheck` additionally confirms an Entry-port host names a bindable local
  // address (loopback / wildcard / a local interface).
  // `test` walks the real jump chain and probes the destination from the far end,
  // resolving to a per-hop `{ hopLabel, host, port, status, reason? }` result;
  // credential decryption and every socket stay in main, so nothing here carries a
  // secret. Host-key prompts raised during a test arrive over the existing
  // porthippo:hostkey-unknown event. `cancel` aborts an in-flight test.
  resolve: {
    lookup: (host) => ipcRenderer.invoke("resolve:lookup", { host }),
    bindcheck: (host) => ipcRenderer.invoke("resolve:bindcheck", { host }),
    test: (payload) => ipcRenderer.invoke("resolve:test", { payload }),
    cancel: () => ipcRenderer.invoke("resolve:cancel"),
  },

  // ── App shell (Feature 60) ────────────────────────────────────────────────
  // i18n.load returns the active locale's catalog (resolved from settings +
  // the OS locale) for the renderer to layer over its embedded English.
  i18n: {
    load: () => ipcRenderer.invoke("i18n:load"),
  },

  // diagnostics.copy builds the redacted diagnostics report, copies it to the
  // clipboard in main, and returns the text (never contains secrets).
  diagnostics: {
    copy: () => ipcRenderer.invoke("diagnostics:copy"),
  },

  // ── Selectable secret storage (Feature 90) ────────────────────────────────
  // The renderer only sends mode/unlock INTENTS; all crypto, keychain access and
  // re-encryption happen in main. Nothing here ever carries a decrypted secret or
  // key material — only the mode/lock status, and (write-only, inbound) a master
  // password to set or verify. A mode/unlock change is announced back via the
  // one-way porthippo:secret-storage-changed event (wired below).
  secretStorage: {
    getMode: () => ipcRenderer.invoke("secret-storage:get-mode"),
    // payload: { mode, password? }  →  { ok, reason?, failures? }
    setMode: (payload) =>
      ipcRenderer.invoke("secret-storage:set-mode", payload),
    // Wrap the bare password into the channel's { password } request shape.
    unlock: (password) =>
      ipcRenderer.invoke("secret-storage:unlock", { password }),
    lock: () => ipcRenderer.invoke("secret-storage:lock"),
  },

  // ── Auto-update (Feature 70) ──────────────────────────────────────────────
  // The renderer only sends intents; lifecycle events arrive one-way over the
  // `porthippo:update-*` events (re-dispatched below). `check` runs a manual
  // update check; `install` restarts to apply a downloaded update (user-confirmed
  // from the "update ready" prompt). Neither carries any secret.
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
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
  "porthippo:stats",
  "porthippo:hostkey-unknown",
  "porthippo:hostkey-changed",
  // Feature 90: the at-rest secret-storage mode / lock status changed. Carries
  // { mode, locked, available, hasPassword } — never a secret or key material.
  "porthippo:secret-storage-changed",
]) {
  ipcRenderer.on(channel, (_event, detail) => {
    window.dispatchEvent(new CustomEvent(channel, { detail }));
  });
}

// ── App-menu / tray commands (Feature 60) ─────────────────────────────────────
// Native chrome the main process owns (the app menu + tray) drives the renderer
// by sending a `menu:*` command, which we re-dispatch as a global `porthippo:*`
// CustomEvent that app.js binds — the same one-way convention as above. Engine
// intents (arm-all / disarm-all) are handled directly in main and don't appear
// here; these are the commands only the renderer can carry out.
const MENU_EVENT_MAP = {
  "menu:open-settings": "porthippo:open-settings",
  "menu:new-tunnel": "porthippo:new-tunnel",
  "menu:show-about": "porthippo:show-about",
};
for (const [channel, domEvent] of Object.entries(MENU_EVENT_MAP)) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(domEvent, { detail: payload }));
  });
}

// ── Auto-update lifecycle (Feature 70) ────────────────────────────────────────
// updater.js pushes each electron-updater event over an `updater:*` channel; we
// re-dispatch as a `porthippo:update-*` CustomEvent (same one-way convention) so
// the renderer's UpdateNotifier can surface toasts + the "restart to install"
// prompt. Payloads carry only version / progress / message — never a secret.
const UPDATE_EVENT_MAP = {
  "updater:checking": "porthippo:update-checking",
  "updater:available": "porthippo:update-available",
  "updater:not-available": "porthippo:update-not-available",
  "updater:progress": "porthippo:update-progress",
  "updater:downloaded": "porthippo:update-downloaded",
  "updater:error": "porthippo:update-error",
};
for (const [channel, domEvent] of Object.entries(UPDATE_EVENT_MAP)) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(domEvent, { detail: payload }));
  });
}
