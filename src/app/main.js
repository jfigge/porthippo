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

// main.js — Electron main process for Jump Hippo.
//
// Owns all native I/O — sockets, SSH, filesystem, the tray/menu, logging — and
// exposes it to the sandboxed renderer only through the window.jumphippo bridge
// (preload.js). Feature 60 turns Jump Hippo into a background-capable app: a
// single-instance lock, a status tray, hide-to-tray (closing the window keeps
// tunnels alive — only an explicit Quit disarms), launch-at-login, a native
// menu, rotating logs + diagnostics, and the i18n seam that localizes main-side
// chrome.
"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  webContents,
} = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { parseArgs } = require("./cli-args");
const { Stores } = require("./store/stores");
const { registerStoreIPC } = require("./ipc/store");
const { registerEngineIPC } = require("./ipc/engine");
const { registerResolveIPC } = require("./ipc/resolve");
const { registerDialogIPC } = require("./ipc/dialog");
const { registerContextMenuIPC } = require("./ipc/context-menu");
const { registerShellIPC } = require("./ipc/shell");
const { registerSecretStorageIPC } = require("./ipc/secret-storage");
const { registerPortableIPC } = require("./ipc/portable");
const { TunnelEngine } = require("./tunnel/engine");
const { Scheduler } = require("./scheduler");
const { readSsid } = require("./network-info");
const {
  listOsKnownHosts,
  defaultKnownHostsPath,
} = require("./tunnel/host-verifier");
const i18n = require("./i18n");
const { createLogger } = require("./logger");
const { buildReport } = require("./diagnostics");
const { installAppMenu } = require("./menu");
const { createTray, LIVE_STATES } = require("./tray");
const { buildTrayImage } = require("./tray-icon");
const { createNotifications } = require("./notifications");
const { createLoginItem } = require("./login-item");
const {
  DEFAULT_BOUNDS,
  resolveWindowBounds,
  trackWindowState,
} = require("./window-state");
const updater = require("./updater");
const { distribution, isStoreBuild, buildInfo } = require("./store-build");

// Delay the silent startup update check so it never competes with window
// creation / first paint. A manual check (Settings/menu) runs immediately.
const STARTUP_UPDATE_CHECK_DELAY_MS = 10_000;

// Upper bound on how long quit waits for SSH sessions to close cleanly before
// exiting anyway — a graceful teardown that hangs must never wedge the exit.
const QUIT_DISARM_TIMEOUT_MS = 3_000;

const {
  dev: isDev,
  hotReload: isHotReload,
  devTools: isDevTools,
} = parseArgs(process.argv);

// ─── Logging ────────────────────────────────────────────────────────────────
// Install the rotating file logger FIRST so the console tee captures the
// earliest main-process diagnostics into userData/logs. getPath('userData') is
// resolvable before app.whenReady(); fall back to a temp dir if it isn't.
function resolveLogsDir() {
  try {
    return path.join(app.getPath("userData"), "logs");
  } catch {
    return path.join(os.tmpdir(), "jumphippo-logs");
  }
}
// Pass the resolver as a THUNK, not a resolved string: under the macOS App
// Sandbox, app.getPath("userData") read here at module-load (before
// app.whenReady()) points outside the writable container, so every log write
// would be silently denied and the entire MAS log would go missing. The lazy
// dir re-resolves on each write, landing the log in the container once the app
// is ready — matching how the store (getStores) already defers its path.
const logger = createLogger({ dir: resolveLogsDir });
logger.install();

/**
 * Resolve the app's own version. In a packaged build app.getVersion() returns
 * the productName version, but when running unpackaged (make debug) it falls
 * back to Electron's version — so prefer the package.json value.
 */
function resolveAppVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return app.getVersion();
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────
// The store factory owns all filesystem I/O + secret encryption. Built lazily on
// the first use so app.getPath is resolvable and the keychain/app-key bootstrap
// runs after Electron is ready.
let _stores = null;

/** @returns {Stores} */
function getStores() {
  if (!_stores) _stores = new Stores(app.getPath("userData"));
  return _stores;
}

// ─── Tunnel engine (Feature 20) ─────────────────────────────────────────────────
let _engine = null;

/** The shared TunnelEngine (created in app.whenReady). */
function getEngine() {
  return _engine;
}

// ─── Scheduler (Feature 150) ────────────────────────────────────────────────────
// Owns time/network-driven auto-arm; issues plain engine arm/disarm. Created in
// app.whenReady after the engine, and fed the master switch from settings.
let _scheduler = null;

/**
 * Push a one-way event to every live renderer. Skips destroyed contexts so it
 * survives window hide/show and tray-only operation.
 */
function broadcastToRenderer(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    try {
      wc.send(channel, payload);
    } catch (err) {
      console.error(`[main] broadcast ${channel} failed:`, err && err.message);
    }
  }
}

// The engine's broadcaster: fan out to the renderer AND refresh the tray + raise
// desktop notifications on the relevant one-way events (byte-rate
// `jumphippo:stats` heartbeats don't affect the tray's count/tooltip, so those
// are skipped to avoid rebuilding the menu every second).
function broadcast(channel, payload) {
  broadcastToRenderer(channel, payload);
  if (channel === "jumphippo:tunnel-state") {
    _tray?.update(); // count/tooltip + health rollup
    // Feature 140: a bulk action coalesces into ONE broadcast carrying an ARRAY of
    // snapshots; a single change is still a lone object. Notify per tunnel.
    const list = Array.isArray(payload) ? payload : [payload];
    for (const one of list) _notifications?.onTunnelState(one);
  } else if (channel === "jumphippo:hostkey-changed") {
    _notifications?.onHostKeyChanged(payload); // security alert (name only)
  }
}

/** Send a one-way command to the (single) renderer window. */
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Main-process error conventions ──────────────────────────────────────────
function safeCall(channel, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[main] ${channel} error:`, err && err.message);
    return fallback;
  }
}

function safeCallWrite(channel, fn) {
  try {
    const result = fn();
    return result === undefined ? null : result;
  } catch (err) {
    console.error(`[main] ${channel} error:`, err && err.message);
    return {
      __hippoError: true,
      channel,
      message: err && err.message,
      code: err && err.code,
      errors: err && err.errors,
    };
  }
}

// ─── i18n (main-process chrome) ─────────────────────────────────────────────────
// The menu/tray/dialogs can't reach the renderer's t(), so main resolves labels
// against its own catalog, refreshed from the persisted language + OS locale.
let _catalog = i18n.loadCatalog({ systemLocale: "en" });

function refreshCatalog() {
  let requested = "system";
  try {
    requested = getStores().settingsStore().get().language || "system";
  } catch {
    /* pre-store default */
  }
  _catalog = i18n.loadCatalog({ requested, systemLocale: app.getLocale() });
  return _catalog;
}

// label(key, fallback) — no interpolation; t(key, params) — interpolates. Both
// read the LIVE `_catalog`, so a locale change reflects on the next menu/tray
// rebuild without recreating them.
const label = (key, fallback) => i18n.label(_catalog, key, fallback);
const t = (key, params) => i18n.format(i18n.label(_catalog, key, key), params);

// ─── Launch at login ─────────────────────────────────────────────────────────
const loginItem = createLoginItem({ app, appName: "Jump Hippo" });

// Sync the OS login-item with the persisted setting. Only in packaged builds —
// in dev the executable is the Electron binary, which we must not register — and
// never in a store build, where launch-at-login is disabled (the setting is
// hidden in the renderer too; this is the belt-and-braces main-side guard). See
// store-build.js → capabilities().launchAtLogin.
function applyLoginItem(settings) {
  if (!app.isPackaged || isStoreBuild()) return;
  loginItem.set(Boolean(settings.launchAtLogin), {
    openAsHidden: Boolean(settings.startMinimized),
  });
}

// ─── Diagnostics ───────────────────────────────────────────────────────────────
function collectAppInfo() {
  return {
    version: resolveAppVersion(),
    platform: `${process.platform}/${process.arch}`,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${os.type()} ${os.release()}`,
    locale: app.getLocale(),
    packaged: String(app.isPackaged),
    // "store" (Mac App Store / Microsoft Store) or "direct" (GitHub-release
    // builds) — records which channel produced the build. See store-build.js.
    distribution: distribution(),
  };
}

/** Build the redacted diagnostics report, copy it to the clipboard, return it. */
function copyDiagnostics() {
  const report = buildReport({
    app: collectAppInfo(),
    tunnels: safeCall(
      "diagnostics:tunnels",
      () => getStores().tunnelStore().list(),
      [],
    ),
    credentials: safeCall(
      "diagnostics:credentials",
      () => getStores().credentialStore().list(),
      [],
    ),
    logs: logger.readTail(),
    generatedAt: new Date().toISOString(),
  });
  try {
    clipboard.writeText(report);
  } catch (err) {
    console.error("[main] clipboard write failed:", err && err.message);
  }
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: t("tray.copyDiagnostics"),
        body: t("shell.diagnostics.copied"),
      }).show();
    }
  } catch {
    /* notifications are best-effort */
  }
  return report;
}

// ─── Tray + status ─────────────────────────────────────────────────────────────
let _tray = null;
let _notifications = null; // desktop failure/health notifications (Feature 130)

/** A snapshot of every definition's name + engine state for the tray. */
function getStatus() {
  const defs = safeCall(
    "tray:list",
    () => getStores().tunnelStore().list(),
    [],
  );
  const states = new Map();
  // Ids the engine reports as mid-reconnect (an `attempt` / `nextRetryAt` rides
  // the status snapshot while a backoff retry is scheduled — Feature 130).
  const reconnecting = new Set();
  try {
    for (const s of getEngine()?.status() || []) {
      states.set(s.id, s.state);
      if (s.attempt || s.nextRetryAt) reconnecting.add(s.id);
    }
  } catch (err) {
    console.error("[main] status snapshot failed:", err && err.message);
  }
  const tunnels = defs.map((d) => ({
    id: d.id,
    name: d.name,
    state: states.get(d.id) || "disarmed",
  }));
  const active = tunnels.filter((x) => LIVE_STATES.has(x.state)).length;
  const connected = tunnels.filter((x) => x.state === "connected").length;
  // Aggregate health (Feature 130): error if any tunnel gave up / errored,
  // reconnecting if any is mid-retry, else healthy. Computed once here and fed to
  // the tray glyph + menu so there's no second source of truth.
  const reconnectingCount = tunnels.filter((x) =>
    reconnecting.has(x.id),
  ).length;
  const errorCount = tunnels.filter((x) => x.state === "error").length;
  const health =
    errorCount > 0
      ? "error"
      : reconnectingCount > 0
        ? "reconnecting"
        : "healthy";
  // Groups (Feature 140) for the tray + menu submenus: each with its member ids
  // and an armed/total rollup so the tray can gate arm-all / disarm-all.
  const groupDefs = safeCall(
    "tray:groups",
    () => getStores().groupStore().list(),
    [],
  );
  const groups = groupDefs.map((g) => {
    const ids = defs.filter((d) => d.groupId === g.id).map((d) => d.id);
    const armed = ids.filter((id) =>
      LIVE_STATES.has(states.get(id) || "disarmed"),
    ).length;
    return {
      id: g.id,
      name: g.label,
      color: g.color,
      ids,
      armed,
      total: ids.length,
    };
  });
  return {
    tunnels,
    total: tunnels.length,
    active,
    connected,
    health,
    reconnecting: reconnectingCount,
    errored: errorCount,
    groups,
  };
}

/** Resolve a tunnel id to its display name (for a name-only notification). */
function tunnelName(id) {
  const def = safeCall(
    "notify:name",
    () => getStores().tunnelStore().get(id),
    null,
  );
  return (def && def.name) || undefined;
}

/** Tell the scheduler the user hand-armed/disarmed these tunnels (Feature 150). */
function noteManualOverride(ids) {
  if (_scheduler && Array.isArray(ids) && ids.length) {
    _scheduler.noteManual(ids);
  }
}

// The user's "Arm all" (tray/menu): arm every enabled tunnel, and tell the
// scheduler it now owns the governed ones by hand until the next boundary.
const armAll = () => {
  noteManualOverride([...(_scheduler?.governedIds() ?? [])]);
  return getEngine()
    ?.armAll()
    .catch((err) => console.error("[main] armAll failed:", err && err.message));
};

// Startup arming: arm enabled tunnels but leave scheduled ones to the scheduler
// (Feature 150), so launch and the scheduler never race over the same tunnel.
const launchArm = () => {
  const skip = _scheduler?.governedIds() ?? new Set();
  return getEngine()
    ?.armAll({ skip })
    .catch((err) =>
      console.error("[main] launch arm failed:", err && err.message),
    );
};

// Set true when startup arming is deferred because the secret store booted
// LOCKED (master-password mode). A successful unlock — from the launch prompt or
// Settings → Security — runs the deferred armAll exactly once (see onUnlock).
let armOnUnlockPending = false;

// Set true when the scheduler's start was deferred because the secret store booted
// LOCKED (master-password mode); enabled on unlock, so a governed tunnel's listener
// isn't bound before the session can decrypt its credential (Feature 150).
let schedulerEnablePending = false;

/** Is the secret store currently locked (master-password mode, no key loaded)? */
function secretStorageLocked() {
  return safeCall(
    "startup:lock-state",
    () => getStores().secretStorage().getState().locked === true,
    false,
  );
}

/**
 * Arm enabled definitions now, or — when the store booted locked — defer until
 * the session is unlocked. Binding a listener needs no secret, but a locked
 * store can't decrypt a stored password/passphrase, so we hold off entirely and
 * let the unlock-on-launch prompt resume us rather than surface auth failures.
 */
function armEnabledOrDeferForUnlock() {
  if (secretStorageLocked()) {
    armOnUnlockPending = true;
    return;
  }
  launchArm();
}

/** Resume the deferred scheduler start + launch arm after the session is unlocked. */
function resumeDeferredArm() {
  // Start the scheduler first so `launchArm` can skip the tunnels it now governs.
  if (schedulerEnablePending) {
    schedulerEnablePending = false;
    _scheduler?.setEnabled(true);
  }
  if (!armOnUnlockPending) return;
  armOnUnlockPending = false;
  launchArm();
}

const disarmAll = () => {
  noteManualOverride([...(_scheduler?.governedIds() ?? [])]);
  return getEngine()
    ?.disarmAll()
    .catch((err) =>
      console.error("[main] disarmAll failed:", err && err.message),
    );
};

// ── Group bulk actions (Feature 140) ─────────────────────────────────────────
// The engine stays group-unaware: "arm this group" is resolved to its member ids
// (read live at click time) and applied as one coalesced bulk op.
function groupMemberIds(groupId) {
  const defs = safeCall(
    "group:members",
    () => getStores().tunnelStore().list(),
    [],
  );
  return defs.filter((d) => d && d.groupId === groupId).map((d) => d.id);
}

function applyToGroup(groupId, action) {
  const ids = groupMemberIds(groupId);
  if (ids.length === 0) return;
  // Arming / disarming a group by hand is a scheduling override for its governed
  // members; pause/resume don't change the armed state, so they aren't.
  if (action === "arm" || action === "disarm") noteManualOverride(ids);
  getEngine()
    ?.applyToMany(ids, action)
    .catch((err) =>
      console.error(`[main] group ${action} failed:`, err && err.message),
    );
}

const armGroup = (id) => applyToGroup(id, "arm");
const disarmGroup = (id) => applyToGroup(id, "disarm");

function createTrayPresence() {
  // Rebuild the tray image from the current status so its badge tracks the
  // connected-tunnel count on every state change. The glyph is monochrome; on
  // macOS it is a template image the menu bar tints for the active appearance.
  const template = process.platform === "darwin";
  const renderImage = (status) =>
    buildTrayImage({
      nativeImage,
      template,
      count: (status && status.connected) || 0,
      health: (status && status.health) || "healthy",
    });
  _tray = createTray({
    Tray,
    Menu,
    image: renderImage(getStatus()),
    renderImage,
    t,
    getStatus,
    actions: {
      showWindow,
      armAll,
      disarmAll,
      arm: (id) => {
        noteManualOverride([id]);
        return getEngine()
          ?.arm(id)
          .catch((err) =>
            console.error("[main] arm failed:", err && err.message),
          );
      },
      disarm: (id) => {
        noteManualOverride([id]);
        return getEngine()
          ?.disarm(id)
          .catch((err) =>
            console.error("[main] disarm failed:", err && err.message),
          );
      },
      armGroup,
      disarmGroup,
      openSettings,
      copyDiagnostics,
      quit: requestQuit,
    },
  });
}

// ─── Native menu ─────────────────────────────────────────────────────────────
function refreshMenu() {
  installAppMenu({
    app,
    Menu,
    label,
    isDev: isDev || isDevTools || isHotReload,
    // Per-group arm-all/disarm-all submenus (Feature 140). Only the group id +
    // name are needed here; member ids are resolved live when a submenu is clicked.
    groups: getStatus().groups.map((g) => ({ id: g.id, name: g.name })),
    actions: {
      newTunnel: () => {
        showWindow();
        sendToRenderer("menu:new-tunnel");
      },
      armAll,
      disarmAll,
      armGroup,
      disarmGroup,
      openSettings,
      copyDiagnostics,
      showLogs: () => shell.openPath(logger.dir),
      userGuide: showDocsWindow,
      about: showAbout,
      checkUpdates: () => updater.checkForUpdates({ manual: true }),
      // View ▸ font zoom: the renderer owns the step logic (it also handles the
      // keyboard/wheel gestures), so the menu just forwards the direction.
      fontChange: (direction) => sendToRenderer("menu:font-change", direction),
      quit: requestQuit,
    },
  });
}

// Open the in-app About dialog (Rest Hippo style): show the window, then ask the
// renderer to mount it. The native About panel / message box is retired.
function showAbout() {
  showWindow();
  sendToRenderer("menu:show-about");
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────
function registerIpc() {
  const version = resolveAppVersion();
  ipcMain.handle("app:version", () => version);
  // Build metadata + capability map for the sandboxed renderer, which can't read
  // process.mas itself. The UI gates store-incompatible features on this. See
  // store-build.js and preload.js (window.jumphippo.build).
  ipcMain.handle("app:capabilities", () => buildInfo());

  registerStoreIPC({
    ipcMain,
    getStores,
    safeCall,
    safeCallWrite,
    // The Host Keys panel's "Operating System" tab reads ~/.ssh/known_hosts for a
    // read-only inventory (Jump Hippo never edits that file — the OS owns it).
    readOsKnownHosts: () => ({
      path: defaultKnownHostsPath(),
      entries: listOsKnownHosts(),
    }),
    afterWrite: (id) => {
      getEngine()
        ?.reconcile(id)
        .catch((err) =>
          console.error(`[main] reconcile ${id} error:`, err && err.message),
        );
      // A create/edit/delete can add, change, or remove a tunnel's schedule, so
      // the scheduler must re-read the governed set (Feature 150).
      _scheduler?.refresh();
      // The tray renders the tunnel list; a create/rename/delete (or an edit to a
      // disabled/disarmed tunnel, which emits no state broadcast) must refresh it,
      // otherwise a deleted tunnel lingers and a new one is absent until some
      // unrelated tunnel next changes state.
      _tray?.update();
    },
    // A credential / jump-host edit can change the resolved plan of many tunnels;
    // reconcile the whole engine so every referencing tunnel re-reads it. It can
    // also change a tunnel's route summary, so refresh the tray too.
    afterRefsWrite: () => {
      getEngine()
        ?.reconcileAll()
        .catch((err) =>
          console.error("[main] reconcileAll error:", err && err.message),
        );
      _tray?.update();
    },
    // A group create/rename/delete/reorder (Feature 140) changes no routing, so it
    // triggers NO engine reconcile — but the tray + native-menu group submenus
    // must rebuild to reflect the new set (a group edit emits no state broadcast).
    afterGroupsWrite: () => {
      // A group's schedule is inherited by its members, so a group edit can change
      // the governed set (Feature 150) — re-read it.
      _scheduler?.refresh();
      _tray?.update();
      refreshMenu();
    },
    // After a settings change, apply the platform side-effects the renderer
    // can't (launch-at-login), and toggle the scheduler master switch (Feature
    // 150). Theme/language/defaults are live-applied in the renderer; language
    // additionally re-localizes main chrome on the reload (did-finish-load →
    // refreshCatalog + refreshMenu + tray.update).
    afterSettingsWrite: (settings) => {
      applyLoginItem(settings);
      _scheduler?.setEnabled(settings.schedulingEnabled === true);
    },
  });

  registerEngineIPC({
    ipcMain,
    getEngine,
    // Feature 150: a hand arm/disarm over IPC is a scheduling override.
    onManual: noteManualOverride,
  });

  // Feature 150: current schedule status (which tunnels are managed, their next
  // transition, and any manual override) for the renderer's row adornments. Live
  // updates arrive one-way over the jumphippo:schedule broadcast.
  ipcMain.handle("schedule:status", () =>
    _scheduler ? _scheduler.status() : { enabled: false, tunnels: [] },
  );

  // Feature 150: the editor's "use current network" helper. Reads the current
  // Wi-Fi SSID best-effort and returns it (null when it can't be read); the name
  // is shown only in the user's own editor and is never logged.
  ipcMain.handle("schedule:current-network", async () => {
    try {
      const res = await readSsid();
      return { ssid: res.status === "ok" ? res.ssid : null };
    } catch {
      return { ssid: null };
    }
  });

  // Hostname-resolution validation (Feature 100): live local DNS lookups + the
  // "Test resolution" probe that walks the real chain (host-key prompts flow over
  // the engine's existing jumphippo:hostkey-unknown broadcast).
  registerResolveIPC({ ipcMain, getStores, getEngine });

  registerDialogIPC({ ipcMain, dialog, getMainWindow: () => mainWindow });

  // Native OS context menu for a right-clicked tunnel row: the renderer sends a
  // label/id template and awaits the clicked id; main just pops the menu.
  registerContextMenuIPC({ ipcMain, Menu, getMainWindow: () => mainWindow });

  // App-shell IPC (Feature 60): i18n catalog + diagnostics report.
  registerShellIPC({
    ipcMain,
    safeCall,
    loadCatalog: () => refreshCatalog(),
    copyDiagnostics,
  });

  // Selectable secret storage (Feature 90): mode switch / unlock / lock. On a
  // successful change it reconciles the engine and broadcasts so the UI + live
  // tunnels pick up the new key state.
  registerSecretStorageIPC({
    ipcMain,
    getStores,
    getEngine,
    broadcast,
    safeCall,
    // A successful unlock resumes any startup arming deferred while locked.
    onUnlock: resumeDeferredArm,
  });

  // Import / export (Feature 120): the `.jumphippo` bundle round-trip and the
  // read-only ~/.ssh/config importer. Native file dialogs are opened in main; a
  // successful import reconciles the engine so affected tunnels re-read.
  registerPortableIPC({
    ipcMain,
    getStores,
    getEngine,
    dialog,
    getMainWindow: () => mainWindow,
  });

  // Auto-update (Feature 70) intents. `check` runs a manual (noisy) check; the
  // lifecycle events reach the renderer over the `updater:*` push channels.
  // `install` restarts to apply a downloaded update (user-confirmed in the UI).
  ipcMain.handle("updater:check", () => {
    updater.checkForUpdates({ manual: true });
    return { ok: true };
  });
  ipcMain.handle("updater:install", () => {
    updater.quitAndInstall();
    return { ok: true };
  });

  // User-guide docs (Feature 80): return the markdown source of a bundled help
  // page so the docs window's DocsViewer can render it. Reading over IPC (not
  // fetch) works identically under file:// (packaged / make debug). `page` is a
  // bare slug → src/web/docs/<slug>.md; it is strictly validated and the resolved
  // path confirmed to stay inside docsDir, so a crafted name can't escape it.
  // Invoked from the docs window's narrow preload-docs.js (see the ipc-parity
  // test, which scans both preloads).
  const docsDir = path.join(__dirname, "..", "web", "docs");
  ipcMain.handle("docs:read", async (_event, page) => {
    if (typeof page !== "string" || !/^[A-Za-z0-9-]+$/.test(page)) {
      throw new Error(`Invalid docs page: ${page}`);
    }
    const filePath = path.join(docsDir, `${page}.md`);
    if (path.relative(docsDir, filePath).startsWith("..")) {
      throw new Error(`Docs page outside docs dir: ${page}`);
    }
    return fs.promises.readFile(filePath, "utf8");
  });
}

// ─── Hot reload (dev only) ────────────────────────────────────────────────────
function installHotReload(win) {
  const webDir = path.join(__dirname, "..", "web");
  let timer = null;
  try {
    fs.watch(webDir, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
      }, 120);
    });
  } catch (err) {
    console.error("[main] hot-reload watcher failed:", err && err.message);
  }
}

// ─── App icon ─────────────────────────────────────────────────────────────────
function loadAppIcon() {
  const file =
    process.platform === "darwin"
      ? path.join(__dirname, "..", "web", "jumphippo-mac-icon.png")
      : path.join(__dirname, "..", "web", "icons", "512x512.png");
  const icon = nativeImage.createFromPath(file);
  return icon.isEmpty() ? undefined : icon;
}

const appIcon = loadAppIcon();

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;
let _docsWin = null; // singleton user-guide window (Feature 80)
// Set true only by an explicit Quit; the window `close` handler hides instead of
// closing until this flips, so closing the window keeps tunnels alive.
let isQuitting = false;

function createWindow({ show = true } = {}) {
  // Restore the last position/size when it still fits on a connected display;
  // otherwise fall back to the centred default (resolveWindowBounds decides).
  const displays = safeCall(
    "window:displays",
    () =>
      screen
        .getAllDisplays()
        .map((d) => ({ bounds: d.bounds, workArea: d.workArea })),
    [],
  );
  const savedBounds = safeCall(
    "window:bounds",
    () => getStores().settingsStore().get().windowBounds,
    null,
  );
  const bounds = resolveWindowBounds(savedBounds, displays, DEFAULT_BOUNDS);

  const win = new BrowserWindow({
    ...bounds, // x/y only when restored; width/height always
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1c1c1c",
    icon: appIcon,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "web", "index.html"));

  mainWindow = win;

  // Persist position/size as the user moves/resizes (debounced) and on close.
  trackWindowState(win, {
    save: (b) =>
      safeCall("window:save-bounds", () =>
        getStores().settingsStore().set({ windowBounds: b }),
      ),
  });

  // Close hides to the tray (keeping tunnels alive) until a real Quit is in
  // progress; first time, tell the user where the app went.
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    win.hide();
    maybeShowHideNotice();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Disable Chromium's built-in pinch/ctrl-wheel visual zoom — the renderer
  // intercepts those gestures and steps the settings fontSize (a real zoom
  // factor) instead, so the whole UI scales through one code path.
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});

  // Re-localize main chrome whenever the renderer (re)loads — e.g. after a
  // language change reloads the window.
  win.webContents.on("did-finish-load", () => {
    refreshCatalog();
    refreshMenu();
    _tray?.update();
  });

  if (show) win.once("ready-to-show", () => win.show());

  if (isDev || isDevTools) win.webContents.openDevTools({ mode: "bottom" });
  if (isHotReload) installHotReload(win);

  return win;
}

/** Show and focus the window, creating it if it was fully closed. */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow({ show: true });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Open the window and ask the renderer to show the Settings panel. */
function openSettings() {
  showWindow();
  sendToRenderer("menu:open-settings");
}

// ─── User guide (Feature 80) ────────────────────────────────────────────────
// A singleton, independent window (no `parent`) so the guide can stay open beside
// the main window while the user keeps working. Markdown is rendered in-window;
// its narrow preload (preload-docs.js) exposes only the docs:read IPC.
function showDocsWindow() {
  if (_docsWin && !_docsWin.isDestroyed()) {
    _docsWin.focus();
    return;
  }
  // Pass the active theme so the guide opens in the same palette as the app.
  const theme = safeCall(
    "docs:theme",
    () => getStores().settingsStore().get().theme,
    "system",
  );

  _docsWin = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    autoHideMenuBar: true,
    title: label("menu.userGuide", "Jump Hippo User Guide"),
    icon: appIcon,
    backgroundColor: "#1c1c1c",
    webPreferences: {
      preload: path.join(__dirname, "preload-docs.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  _docsWin.loadFile(path.join(__dirname, "..", "web", "docs.html"), {
    query: { theme },
  });

  // Open external doc links (DOMPurify forces target=_blank) in the system
  // browser; deny everything else — the docs window never navigates itself.
  _docsWin.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = "";
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: "deny" };
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") {
      shell.openExternal(url).catch(() => {});
    }
    return { action: "deny" };
  });

  _docsWin.once("closed", () => {
    _docsWin = null;
  });
}

// One-off "still running in the tray" notification, persisted so it shows once.
function maybeShowHideNotice() {
  let seen = false;
  try {
    seen = getStores().settingsStore().get().trayHintSeen === true;
  } catch {
    /* ignore */
  }
  if (seen) return;
  try {
    getStores().settingsStore().set({ trayHintSeen: true });
  } catch {
    /* ignore */
  }
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: t("shell.hide.title"),
        body: t("shell.hide.body"),
      }).show();
    }
  } catch {
    /* best-effort */
  }
}

/** The single quit path: optional confirm, then flag + quit (before-quit disarms). */
function requestQuit() {
  if (isQuitting) return;

  let confirmOnQuit = false;
  try {
    confirmOnQuit = getStores().settingsStore().get().confirmOnQuit === true;
  } catch {
    /* ignore */
  }
  if (confirmOnQuit) {
    const choice = dialog.showMessageBoxSync(mainWindow ?? undefined, {
      type: "question",
      title: t("shell.quit.title"),
      message: t("shell.quit.title"),
      detail: t("shell.quit.message"),
      buttons: [t("shell.quit.confirm"), t("common.cancel")],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) return;
  }

  isQuitting = true;
  app.quit();
}

// ─── Single-instance lock ──────────────────────────────────────────────────────
// A second launch focuses the running window and exits — the store is a single
// writer. Skipped under --hot-reload, whose self-relaunch would race the lock.
const gotSingleInstanceLock = isHotReload || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  bootstrap();
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
function bootstrap() {
  app.whenReady().then(() => {
    if (
      process.platform === "darwin" &&
      !app.isPackaged &&
      app.dock &&
      appIcon
    ) {
      app.dock.setIcon(appIcon);
    }

    // Resolve the catalog for main-side chrome, then create the engine (broadcasts
    // fan out to the renderer + tray).
    refreshCatalog();
    _engine = new TunnelEngine({
      getStores,
      broadcast,
      // Feature 150: a store write / unlock must not arm a tunnel the scheduler
      // manages — the scheduler owns its armed state. Read live (the scheduler is
      // created just below), so an empty set until then means "nothing managed".
      getManagedIds: () => _scheduler?.governedIds() ?? new Set(),
    });

    // Scheduler (Feature 150): time/network auto-arm. It only reaches the renderer
    // (row adornments) — the tray tracks armed state via the engine broadcast — so
    // it's fed the renderer-only broadcaster.
    _scheduler = new Scheduler({
      getStores,
      engine: _engine,
      powerMonitor,
      broadcast: broadcastToRenderer,
    });

    // Desktop failure/health notifications (Feature 130): fed by the broadcast tee
    // above. Reads notification prefs live, resolves the tunnel NAME only, and a
    // click focuses the window (the single-instance focus path).
    _notifications = createNotifications({
      Notification,
      t,
      getSettings: () => getStores().settingsStore().get(),
      resolveName: tunnelName,
      focusWindow: showWindow,
    });

    registerIpc();

    // Reconcile the OS login-item with the persisted setting.
    applyLoginItem(
      safeCall("startup:settings", () => getStores().settingsStore().get(), {}),
    );

    // Honour "start minimized to the tray" — create the window hidden so tunnels
    // still arm but no window appears; the user opens it from the tray.
    const settings = safeCall(
      "startup:settings",
      () => getStores().settingsStore().get(),
      {},
    );
    createWindow({ show: !settings.startMinimized });

    // Native menu + tray.
    refreshMenu();
    createTrayPresence();

    // Auto-update (Feature 70): inert under `make debug`. Route its logging into
    // the app log so an update failure is recoverable from a diagnostics report.
    updater.initUpdater(() => mainWindow, logger);
    setTimeout(
      () => updater.checkForUpdates({ manual: false }),
      STARTUP_UPDATE_CHECK_DELAY_MS,
    );

    // Start the scheduler (Feature 150) from the persisted master switch. It
    // governs scheduled tunnels; launch-arming below skips those so the two never
    // race over the same tunnel. When the store boots LOCKED (master password),
    // defer it — like startup arming — so it doesn't bind a governed tunnel's
    // listener before the session can decrypt its credential (resumed on unlock).
    if (settings.schedulingEnabled === true) {
      if (secretStorageLocked()) schedulerEnablePending = true;
      else _scheduler.setEnabled(true);
    }

    // Arm enabled definitions on startup unless the user opted out. In
    // master-password mode the store can boot LOCKED — defer arming until the
    // unlock-on-launch prompt (or Settings) unlocks the session.
    if (settings.armOnLaunch !== false) armEnabledOrDeferForUnlock();

    app.on("activate", () => {
      // macOS: clicking the dock re-shows the (hidden or closed) window.
      showWindow();
    });
  });

  // A background utility stays alive when its window closes — the tray keeps it
  // running (and tunnels up). Only an explicit Quit exits, on every platform.
  app.on("window-all-closed", () => {
    if (isQuitting) app.quit();
  });

  // Tear every tunnel down on quit. Set isQuitting so a window `close` fired as
  // part of shutdown proceeds instead of hiding.
  let _disarmed = false;
  app.on("before-quit", (event) => {
    isQuitting = true;
    if (_disarmed) return; // second pass, after teardown → let the quit proceed
    _tray?.destroy();
    _scheduler?.dispose(); // stop its timers + powerMonitor subscriptions
    if (!_engine) return;
    // Hold the quit until SSH sessions close cleanly, then re-issue it — so remote
    // servers see a graceful close, not an abrupt TCP drop. Bounded by a timeout
    // so a hung teardown can never wedge the exit.
    event.preventDefault();
    _disarmed = true;
    Promise.race([
      _engine.disarmAll().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, QUIT_DISARM_TIMEOUT_MS)),
    ]).finally(() => app.quit());
  });
}
