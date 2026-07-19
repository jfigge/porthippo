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
// single, narrow window.jumphippo bridge. Every later feature extends THIS
// object (tunnels.*, settings.*, stats, …) and must keep it in lockstep with the
// ipcMain handlers in main.js.
//
// SANDBOX RESTRICTION: this runs in Electron's sandboxed renderer, where
// require() is limited to Electron built-ins ONLY. Never require("../anything")
// here — it crashes the preload in packaged (.asar) builds. Anything from the
// main process must arrive over IPC.
"use strict";

const { contextBridge, ipcRenderer, webFrame } = require("electron");

contextBridge.exposeInMainWorld("jumphippo", {
  // Static platform info — available synchronously from the sandboxed preload's
  // process shim, so no IPC round-trip is needed.
  platform: process.platform,
  arch: process.arch,
  // Electron runtime version, shown in the About dialog's build details.
  electron: process.versions?.electron,

  // UI zoom — the renderer maps its fontSize setting to a Chromium zoom factor so
  // the WHOLE interface scales (its font sizes are authored in px). webFrame lives
  // in the sandboxed preload; the renderer can't reach it directly.
  setZoomFactor: (factor) => {
    const f = Number(factor);
    if (Number.isFinite(f) && f > 0) webFrame.setZoomFactor(f);
  },

  // App version comes from the main process (package.json), over IPC — this also
  // proves the ipcMain <-> preload bridge is wired correctly.
  getVersion: () => ipcRenderer.invoke("app:version"),

  // Build metadata (distribution flavor + capability map) so the sandboxed
  // renderer can gate features a store build disables — ssh-agent auth,
  // launch-at-login, the ssh-config default path. The renderer can't read
  // process.mas itself, so main hands it the map. See store-build.js.
  build: {
    info: () => ipcRenderer.invoke("app:capabilities"),
  },

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
    // Rewrite display order by an id list (Feature 140 in-group sequencing).
    reorder: (ids) => ipcRenderer.invoke("tunnels:reorder", ids),

    // ── Engine intents (Feature 20) ─────────────────────────────────────────
    // The renderer only sends intents; live state arrives via the
    // `jumphippo:tunnel-state` / `jumphippo:stats` events below. Arm binds the
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
    // Bulk action over a set of ids (Feature 140 — group arm-all / multi-select).
    // `action` ∈ arm|disarm|pause|resume; one coalesced state update for the set.
    applyMany: (ids, action) =>
      ipcRenderer.invoke("tunnels:apply-many", { ids, action }),
  },

  // ── Consoles (Feature 200) ────────────────────────────────────────────────
  // Interactive remote-shell targets. CRUD mirrors tunnels (reference records,
  // no secrets — secrets live in the shared credential store). `open` mints a
  // session + terminal window and resolves to `{ sessionId, id }` (or a
  // `{ __hippoError }` envelope); the interactive byte stream then flows over the
  // separate one-way console:* channels the terminal window's own bridge owns, not
  // here. Live session state arrives via the jumphippo:console-state event below.
  consoles: {
    list: () => ipcRenderer.invoke("consoles:list"),
    get: (id) => ipcRenderer.invoke("consoles:get", id),
    create: (def) => ipcRenderer.invoke("consoles:create", def),
    update: (id, patch) => ipcRenderer.invoke("consoles:update", id, patch),
    delete: (id) => ipcRenderer.invoke("consoles:delete", id),
    reorder: (ids) => ipcRenderer.invoke("consoles:reorder", ids),
    open: (id) => ipcRenderer.invoke("consoles:open", id),
    close: (sessionId) => ipcRenderer.invoke("consoles:close", sessionId),
    sessions: () => ipcRenderer.invoke("consoles:sessions"),
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

  // ── Reusable tunnel groups (Feature 140) ──────────────────────────────────
  // Organisational only: a tunnel references at most one group by `groupId`.
  // Deleting a group is always allowed (its tunnels fall back to ungrouped);
  // reorder rewrites group order by an id list.
  groups: {
    list: () => ipcRenderer.invoke("groups:list"),
    get: (id) => ipcRenderer.invoke("groups:get", id),
    create: (group) => ipcRenderer.invoke("groups:create", group),
    update: (id, patch) => ipcRenderer.invoke("groups:update", id, patch),
    delete: (id) => ipcRenderer.invoke("groups:delete", id),
    reorder: (ids) => ipcRenderer.invoke("groups:reorder", ids),
  },

  // ── App settings ──────────────────────────────────────────────────────────
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (patch) => ipcRenderer.invoke("settings:set", patch),
  },

  // ── Native file pickers (Feature 40) ──────────────────────────────────────
  // The sandboxed renderer can't read a typed path, so the auth editor's Browse
  // asks main to open a native picker. Resolves to `{ path, remembered }` (or null
  // if cancelled) — never file bytes. `remembered` is true only when main stored a
  // durable security-scoped bookmark for the file (Mac App Store, Feature 190), so
  // the editor can tell the user the key will survive a relaunch; the bookmark blob
  // itself never crosses.
  dialog: {
    // `defaultPath` (optional) opens the panel at that file's location and
    // pre-selects it — used when re-picking an already-chosen key.
    openKeyFile: (defaultPath) =>
      ipcRenderer.invoke("dialog:open-key-file", { defaultPath }),
    // Feature 190 re-pick nudge: whether a stored key `path` needs re-picking to
    // stay readable (true only in a MAS build with no bookmark for it). Returns
    // `{ needsRepick }` — a boolean only; no bookmark blob or file bytes cross.
    keyStatus: (path) => ipcRenderer.invoke("dialog:key-status", { path }),
  },

  // ── Native OS context menu ────────────────────────────────────────────────
  // A right-click on a tunnel row asks main to pop a real OS menu at the cursor.
  // The renderer sends a template of `{ id, label, enabled }` items (+
  // `{ type: "separator" }` dividers) with labels already localized, and awaits
  // the clicked item's id (or `null` when the menu is dismissed). No secret or
  // executable code crosses — only labels and ids.
  contextMenu: {
    popup: (request) => ipcRenderer.invoke("menu:popup", request),
  },

  // ── Accepted SSH host keys (TOFU) ─────────────────────────────────────────
  // `trust`/`reject` resolve an unknown-host-key prompt raised during a
  // connection (the engine holds it pending until one is called). `list`/`revoke`
  // manage the persisted accepted-key store shown in Settings → Host Keys; a
  // revoke forgets a fingerprint so the next connection re-prompts (TOFU).
  hostkeys: {
    trust: (promptId) => ipcRenderer.invoke("hostkeys:trust", promptId),
    reject: (promptId) => ipcRenderer.invoke("hostkeys:reject", promptId),
    list: () => ipcRenderer.invoke("hostkeys:list"),
    listOs: () => ipcRenderer.invoke("hostkeys:list-os"),
    revoke: (hostPort) => ipcRenderer.invoke("hostkeys:revoke", hostPort),
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
  // jumphippo:hostkey-unknown event. `cancel` aborts an in-flight test.
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

  // ── Scheduling & auto-arm (Feature 150) ───────────────────────────────────
  // `status` returns which tunnels the scheduler currently manages, each one's
  // next time-window transition, and whether the user has overridden it until
  // then. Live changes arrive one-way over the jumphippo:schedule event (below).
  // No SSID / network name / probe result ever crosses — only ids + timings.
  schedule: {
    status: () => ipcRenderer.invoke("schedule:status"),
    // The editor's "use current network" helper: the current Wi-Fi SSID (or null
    // when it can't be read). Shown only in the user's own editor.
    currentNetwork: () => ipcRenderer.invoke("schedule:current-network"),
  },

  // ── Selectable secret storage (Feature 90) ────────────────────────────────
  // The renderer only sends mode/unlock INTENTS; all crypto, keychain access and
  // re-encryption happen in main. Nothing here ever carries a decrypted secret or
  // key material — only the mode/lock status, and (write-only, inbound) a master
  // password to set or verify. A mode/unlock change is announced back via the
  // one-way jumphippo:secret-storage-changed event (wired below).
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

  // ── Import / export (Feature 120) ─────────────────────────────────────────
  // The renderer only picks files (via the native dialogs main opens) and reviews
  // the proposed diff; all bundle building, crypto, SSH-config parsing and store
  // writes stay in main. `export` builds a `.jumphippo` bundle (secrets stripped,
  // or sealed under a passphrase). `previewBundle` parses a chosen bundle and
  // returns its add/update/conflict diff; `importBundle` applies it (merge/replace).
  // `scanSshConfig` parses a chosen ~/.ssh/config into proposed drafts;
  // `importSshConfig` commits the selected ones. A decrypted secret never crosses
  // here — only, write-only inbound, a bundle passphrase.
  io: {
    export: (opts) => ipcRenderer.invoke("portable:export", opts),
    previewBundle: () => ipcRenderer.invoke("portable:preview"),
    importBundle: (opts) => ipcRenderer.invoke("portable:import", opts),
    scanSshConfig: () => ipcRenderer.invoke("sshconfig:scan"),
    importSshConfig: (opts) => ipcRenderer.invoke("sshconfig:import", opts),
  },

  // ── Auto-update (Feature 70) ──────────────────────────────────────────────
  // The renderer only sends intents; lifecycle events arrive one-way over the
  // `jumphippo:update-*` events (re-dispatched below). `check` runs a manual
  // update check; `install` restarts to apply a downloaded update (user-confirmed
  // from the "update ready" prompt). Neither carries any secret.
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    install: () => ipcRenderer.invoke("updater:install"),
  },
});

// ── Main → renderer push events ───────────────────────────────────────────────
// The engine pushes live state one-way over these channels. We re-dispatch each as
// a global `jumphippo:*` CustomEvent (matching the renderer's app-wide event
// convention) so any panel can `window.addEventListener(...)`. Only the serializable
// payload crosses; the raw Electron event is stripped. Payloads carry fingerprints
// only — never secrets or key material.
for (const channel of [
  "jumphippo:tunnel-state",
  "jumphippo:stats",
  "jumphippo:hostkey-unknown",
  "jumphippo:hostkey-changed",
  // Feature 90: the at-rest secret-storage mode / lock status changed. Carries
  // { mode, locked, available, hasPassword } — never a secret or key material.
  "jumphippo:secret-storage-changed",
  // Feature 150: the scheduler re-evaluated. Carries { enabled, tunnels: [{ id,
  // wanted, overridden, nextTransitionAt, nextTransitionKind }] } — ids + timings
  // only, never an SSID / network name / probe result.
  "jumphippo:schedule",
  // Feature 200: a console session changed state. Carries { id, sessionId, state }
  // (state ∈ connecting|connected|closed|error) — ids only, never a secret — so the
  // sidebar's console row lamp can track open/closed.
  "jumphippo:console-state",
]) {
  ipcRenderer.on(channel, (_event, detail) => {
    window.dispatchEvent(new CustomEvent(channel, { detail }));
  });
}

// ── App-menu / tray commands (Feature 60) ─────────────────────────────────────
// Native chrome the main process owns (the app menu + tray) drives the renderer
// by sending a `menu:*` command, which we re-dispatch as a global `jumphippo:*`
// CustomEvent that app.js binds — the same one-way convention as above. Engine
// intents (arm-all / disarm-all) are handled directly in main and don't appear
// here; these are the commands only the renderer can carry out.
const MENU_EVENT_MAP = {
  "menu:open-settings": "jumphippo:open-settings",
  "menu:new-tunnel": "jumphippo:new-tunnel",
  "menu:new-console": "jumphippo:new-console",
  "menu:show-about": "jumphippo:show-about",
  // View ▸ Increase/Decrease/Reset Font Size — payload is "in" | "out" | "reset".
  "menu:font-change": "jumphippo:ui-font-change",
};
for (const [channel, domEvent] of Object.entries(MENU_EVENT_MAP)) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(domEvent, { detail: payload }));
  });
}

// ── Auto-update lifecycle (Feature 70) ────────────────────────────────────────
// updater.js pushes each electron-updater event over an `updater:*` channel; we
// re-dispatch as a `jumphippo:update-*` CustomEvent (same one-way convention) so
// the renderer's UpdateNotifier can surface toasts + the "restart to install"
// prompt. Payloads carry only version / progress / message — never a secret.
const UPDATE_EVENT_MAP = {
  "updater:checking": "jumphippo:update-checking",
  "updater:available": "jumphippo:update-available",
  "updater:not-available": "jumphippo:update-not-available",
  "updater:progress": "jumphippo:update-progress",
  "updater:downloaded": "jumphippo:update-downloaded",
  "updater:error": "jumphippo:update-error",
};
for (const [channel, domEvent] of Object.entries(UPDATE_EVENT_MAP)) {
  ipcRenderer.on(channel, (_event, payload) => {
    window.dispatchEvent(new CustomEvent(domEvent, { detail: payload }));
  });
}
