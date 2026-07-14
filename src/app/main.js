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

// main.js — Electron main process for Port Hippo.
//
// Owns all native I/O — sockets, SSH, filesystem, the tray/menu, logging — and
// exposes it to the sandboxed renderer only through the window.porthippo bridge
// (preload.js). Feature 60 turns Port Hippo into a background-capable app: a
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
const { registerShellIPC } = require("./ipc/shell");
const { registerSecretStorageIPC } = require("./ipc/secret-storage");
const { TunnelEngine } = require("./tunnel/engine");
const i18n = require("./i18n");
const { createLogger } = require("./logger");
const { buildReport } = require("./diagnostics");
const { installAppMenu } = require("./menu");
const { createTray, LIVE_STATES } = require("./tray");
const { buildTrayImage } = require("./tray-icon");
const { createLoginItem } = require("./login-item");
const updater = require("./updater");

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
    return path.join(os.tmpdir(), "porthippo-logs");
  }
}
const logger = createLogger({ dir: resolveLogsDir() });
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

// The engine's broadcaster: fan out to the renderer AND refresh the tray on a
// state change (byte-rate `porthippo:stats` heartbeats don't affect the tray's
// count/tooltip, so those are skipped to avoid rebuilding the menu every second).
function broadcast(channel, payload) {
  broadcastToRenderer(channel, payload);
  if (channel === "porthippo:tunnel-state") _tray?.update();
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
const loginItem = createLoginItem({ app, appName: "Port Hippo" });

// Sync the OS login-item with the persisted setting. Only in packaged builds —
// in dev the executable is the Electron binary, which we must not register.
function applyLoginItem(settings) {
  if (!app.isPackaged) return;
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

/** A snapshot of every definition's name + engine state for the tray. */
function getStatus() {
  const defs = safeCall(
    "tray:list",
    () => getStores().tunnelStore().list(),
    [],
  );
  const states = new Map();
  try {
    for (const s of getEngine()?.status() || []) states.set(s.id, s.state);
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
  return { tunnels, total: tunnels.length, active, connected };
}

const armAll = () =>
  getEngine()
    ?.armAll()
    .catch((err) => console.error("[main] armAll failed:", err && err.message));

const disarmAll = () =>
  getEngine()
    ?.disarmAll()
    .catch((err) =>
      console.error("[main] disarmAll failed:", err && err.message),
    );

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
      arm: (id) =>
        getEngine()
          ?.arm(id)
          .catch((err) =>
            console.error("[main] arm failed:", err && err.message),
          ),
      disarm: (id) =>
        getEngine()
          ?.disarm(id)
          .catch((err) =>
            console.error("[main] disarm failed:", err && err.message),
          ),
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
    actions: {
      newTunnel: () => {
        showWindow();
        sendToRenderer("menu:new-tunnel");
      },
      armAll,
      disarmAll,
      openSettings,
      copyDiagnostics,
      showLogs: () => shell.openPath(logger.dir),
      about: showAbout,
      checkUpdates: () => updater.checkForUpdates({ manual: true }),
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

  registerStoreIPC({
    ipcMain,
    getStores,
    safeCall,
    safeCallWrite,
    afterWrite: (id) => {
      getEngine()
        ?.reconcile(id)
        .catch((err) =>
          console.error(`[main] reconcile ${id} error:`, err && err.message),
        );
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
    // After a settings change, apply the platform side-effects the renderer
    // can't (launch-at-login). Theme/language/defaults are live-applied in the
    // renderer; language additionally re-localizes main chrome on the reload
    // (did-finish-load → refreshCatalog + refreshMenu + tray.update).
    afterSettingsWrite: (settings) => applyLoginItem(settings),
  });

  registerEngineIPC({ ipcMain, getEngine });

  // Hostname-resolution validation (Feature 100): live local DNS lookups + the
  // "Test resolution" probe that walks the real chain (host-key prompts flow over
  // the engine's existing porthippo:hostkey-unknown broadcast).
  registerResolveIPC({ ipcMain, getStores, getEngine });

  registerDialogIPC({ ipcMain, dialog, getMainWindow: () => mainWindow });

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
      ? path.join(__dirname, "..", "web", "porthippo-mac-icon.png")
      : path.join(__dirname, "..", "web", "icons", "512x512.png");
  const icon = nativeImage.createFromPath(file);
  return icon.isEmpty() ? undefined : icon;
}

const appIcon = loadAppIcon();

// ─── Window ───────────────────────────────────────────────────────────────────
let mainWindow = null;
// Set true only by an explicit Quit; the window `close` handler hides instead of
// closing until this flips, so closing the window keeps tunnels alive.
let isQuitting = false;

function createWindow({ show = true } = {}) {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
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
    _engine = new TunnelEngine({ getStores, broadcast });

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

    // Arm enabled definitions on startup unless the user opted out.
    if (settings.armOnLaunch !== false) armAll();

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
