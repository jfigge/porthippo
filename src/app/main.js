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
// This is the Feature 00 scaffold: it creates a single window hosting the empty
// Definition / Monitoring two-view shell and exposes the minimal IPC seam
// (app:version) that later features extend. All native I/O — sockets, SSH,
// filesystem — will live in this process; the renderer talks to it only through
// the window.porthippo bridge in preload.js.
"use strict";

const {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  webContents,
} = require("electron");
const path = require("path");
const fs = require("fs");

const { parseArgs } = require("./cli-args");
const { Stores } = require("./store/stores");
const { registerStoreIPC } = require("./ipc/store");
const { registerEngineIPC } = require("./ipc/engine");
const { TunnelEngine } = require("./tunnel/engine");
const updater = require("./updater");

// Delay the silent startup update check so it never competes with window
// creation / first paint. A manual check (Settings/menu) runs immediately.
const STARTUP_UPDATE_CHECK_DELAY_MS = 10_000;

const {
  dev: isDev,
  hotReload: isHotReload,
  devTools: isDevTools,
} = parseArgs(process.argv);

// Resolve the app's own version. In a packaged build app.getVersion() returns
// the productName version, but when running unpackaged (make debug) it falls
// back to Electron's version — so prefer the package.json value and fall back
// to app.getVersion() only if that read ever fails.
function resolveAppVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return app.getVersion();
  }
}

// ─── Storage ──────────────────────────────────────────────────────────────────
// The store factory owns all filesystem I/O + secret encryption. It is built
// lazily on the first store IPC call (not at require time) so app.getPath is
// resolvable and the keychain/app-key bootstrap runs after Electron is ready.

let _stores = null;

/**
 * Return the shared Stores factory, creating it on first call.
 * @returns {Stores}
 */
function getStores() {
  if (!_stores) {
    _stores = new Stores(app.getPath("userData"));
  }
  return _stores;
}

// ─── Tunnel engine (Feature 20) ─────────────────────────────────────────────────
// The single engine owns every live tunnel (listeners, SSH connections, relays). It
// is created eagerly once Electron is ready (so it can arm enabled tunnels on start
// and hold state), and reaches the renderer only through the broadcaster below — it
// never imports Electron itself.

let _engine = null;

/** The shared TunnelEngine (created in app.whenReady). */
function getEngine() {
  return _engine;
}

/**
 * Push a one-way event to every live renderer. Skips destroyed contexts so it
 * survives window close/reopen (macOS activate) and the Feature 60 tray mode.
 * @param {string} channel  e.g. "porthippo:tunnel-state"
 * @param {object} payload  serializable; fingerprints only, never secrets
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

// ── Main-process error conventions ──────────────────────────────────────────
// Thrown store errors advertise their kind on `.code` (INVALID_ID, NOT_FOUND,
// INVALID_DEFINITION, INVALID_ARG, DecryptError codes). The IPC wrappers below
// turn a throw into either a quiet fallback (reads) or a discriminable
// `{ __hippoError }` envelope (writes) so a failure never becomes an unhandled
// rejection in the renderer.

/**
 * Wrap a read store call: log + return a safe fallback on error.
 * @param {string}   channel   IPC channel (for log context)
 * @param {Function} fn        synchronous store call
 * @param {*}        fallback  value returned on error
 */
function safeCall(channel, fn, fallback = null) {
  try {
    return fn();
  } catch (err) {
    console.error(`[main] ${channel} error:`, err && err.message);
    return fallback;
  }
}

/**
 * Wrap a write store call. A failure returns a discriminable
 * `{ __hippoError: true }` envelope (carrying `.code` and, for validation
 * failures, the field-keyed `.errors`) so the renderer can tell a failed save
 * from a successful one and show inline errors.
 * @param {string}   channel  IPC channel (for log context)
 * @param {Function} fn       synchronous store call
 * @returns {*} the call's result on success, or an error envelope on failure
 */
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

// ─── IPC handlers ─────────────────────────────────────────────────────────────
// Keep every ipcMain.handle channel mirrored by a preload.js export (lockstep);
// the tests/ipc-parity.test.js guard fails the build on any drift.
function registerIpc() {
  const version = resolveAppVersion();
  ipcMain.handle("app:version", () => version);

  // Storage: tunnels:* / settings:* / hostkeys:list|revoke (see ipc/store.js).
  // After a successful definition write, reconcile the running tunnel so an edit
  // re-arms (idle) or becomes pending (active), a new enabled tunnel arms, and a
  // deleted one is disposed.
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
    },
  });

  // Engine intents: tunnels:arm|disarm|status|apply, hostkeys:trust|reject.
  registerEngineIPC({ ipcMain, getEngine });

  // Auto-update (Feature 70). The renderer triggers a manual check / restart;
  // the menu + tray triggers arrive in Feature 60. Lifecycle events flow back
  // as updater:* pushes, which preload.js re-dispatches as porthippo:update-*
  // DOM events.
  ipcMain.handle("updater:check", () => {
    updater.checkForUpdates({ manual: true });
    return null;
  });
  ipcMain.handle("updater:quit-and-install", () => {
    updater.quitAndInstall();
    return null;
  });
}

// ─── Hot reload (dev only) ────────────────────────────────────────────────────
// Under `make debug` (--hot-reload) watch the renderer tree and reload the
// window on change. Deliberately dependency-free (fs.watch) — no chokidar.
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
    // Non-fatal: recursive watch is unsupported on some platforms.
    console.error("[main] hot-reload watcher failed:", err && err.message);
  }
}

// ─── App icon ─────────────────────────────────────────────────────────────────
// A large source PNG is loaded once and Electron downscales it as needed. On
// Windows/Linux it becomes the window + taskbar icon; on macOS the window `icon`
// option is ignored (the dock icon comes from the packaged .app bundle), so we
// set the dock icon explicitly when running unpackaged so `make debug` shows our
// icon instead of the default Electron one.
//
// macOS expects the artwork to sit inside the system "safe area" — a rounded
// square filling ~80% of the canvas with transparent padding on every side — so
// the dock renders it at the same visual weight as native apps. We therefore use
// the pre-padded `porthippo-mac-icon.png` on darwin; other platforms use the
// edge-to-edge icon set, which is designed to fill its canvas.
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
// The single app window. Held at module scope so the updater can push lifecycle
// events to whichever window is currently alive.
let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#1c1c1c", // matches --color-base (theme.css) to avoid a launch flash
    icon: appIcon, // used on Windows/Linux; ignored on macOS
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // renderer cannot touch Node directly
      nodeIntegration: false, // keep Node out of the renderer
      sandbox: true, // extra process isolation
    },
  });

  win.loadFile(path.join(__dirname, "..", "web", "index.html"));

  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.once("ready-to-show", () => win.show());

  if (isDev || isDevTools) {
    win.webContents.openDevTools({ mode: "bottom" });
  }
  if (isHotReload) {
    installHotReload(win);
  }

  return win;
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Show our icon in the dev dock (packaged macOS builds use the .app bundle icon).
  if (process.platform === "darwin" && !app.isPackaged && app.dock && appIcon) {
    app.dock.setIcon(appIcon);
  }

  // Create the engine before IPC (so handlers can reach it) and arm every enabled
  // definition on startup — binding listeners; SSH stays disconnected until first
  // access. Broadcasts flow to the renderer via broadcastToRenderer.
  _engine = new TunnelEngine({
    getStores,
    broadcast: broadcastToRenderer,
  });

  registerIpc();
  createWindow();

  // Wire electron-updater and run one debounced, silent startup check. A dev /
  // unpackaged build short-circuits to "not available" (see updater.js), so this
  // is inert under `make debug`.
  updater.initUpdater(() => mainWindow);
  setTimeout(
    () => updater.checkForUpdates({ manual: false }),
    STARTUP_UPDATE_CHECK_DELAY_MS,
  );

  _engine.armAll().catch((err) => {
    console.error("[main] armAll failed:", err && err.message);
  });

  app.on("activate", () => {
    // macOS: re-create a window when the dock icon is clicked and none are open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // Feature 60 makes Port Hippo a background/tray app that keeps tunnels alive
  // when the window closes. For the scaffold, follow the standard convention:
  // quit on all-windows-closed except on macOS.
  if (process.platform !== "darwin") app.quit();
});

// Tear every tunnel down on quit (best-effort — the OS reclaims sockets on exit).
let _disarmed = false;
app.on("before-quit", () => {
  if (_disarmed || !_engine) return;
  _disarmed = true;
  _engine.disarmAll().catch(() => {});
});
