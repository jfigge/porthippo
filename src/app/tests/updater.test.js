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
 * tests/updater.test.js — the auto-update integration (Feature 70) driven without
 * Electron via updater._setTestHooks. Verifies the download policy, the mapping of
 * every electron-updater event onto its `updater:*` push channel (with the manual
 * flag threaded through), the dev-build short-circuit, quitAndInstall's args, the
 * one-shot wiring guard, logger routing, and that a rejected check is swallowed.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const updater = require("../updater");

// A stand-in for electron-updater's autoUpdater: an EventEmitter with settable
// policy flags and spied check/quit methods.
function fakeAutoUpdater({ checkRejects = false } = {}) {
  const au = new EventEmitter();
  au.checkCalls = 0;
  au.quitArgs = null;
  au.checkForUpdates = () => {
    au.checkCalls += 1;
    return checkRejects
      ? Promise.reject(new Error("network down"))
      : Promise.resolve();
  };
  au.quitAndInstall = (isSilent, isForceRunAfter) => {
    au.quitArgs = [isSilent, isForceRunAfter];
  };
  return au;
}

// A window whose webContents.send records every push, so tests can assert channels.
function fakeWindow() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
}

const lastOn = (win, channel) =>
  [...win.sent].reverse().find((m) => m.channel === channel);

test.afterEach(() => updater._setTestHooks()); // restore real (lazy) modules

test("initUpdater sets the download policy and is idempotent", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });

  const win = fakeWindow();
  updater.initUpdater(() => win);
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.allowPrerelease, false);
  const firstCount = au.listenerCount("update-available");

  updater.initUpdater(() => win); // second call must not double-wire
  assert.equal(au.listenerCount("update-available"), firstCount);
});

test("each autoUpdater event maps to its updater:* push channel", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });
  const win = fakeWindow();
  updater.initUpdater(() => win);

  au.emit("checking-for-update");
  assert.ok(lastOn(win, "updater:checking"));

  au.emit("update-available", { version: "1.2.3" });
  assert.deepEqual(lastOn(win, "updater:available").payload, {
    version: "1.2.3",
    manual: false,
  });

  au.emit("update-not-available");
  assert.ok(lastOn(win, "updater:not-available"));

  au.emit("download-progress", {
    percent: 42,
    transferred: 10,
    total: 20,
    bytesPerSecond: 5,
  });
  assert.deepEqual(lastOn(win, "updater:progress").payload, {
    percent: 42,
    transferred: 10,
    total: 20,
    bytesPerSecond: 5,
  });

  au.emit("update-downloaded", { version: "1.2.3" });
  assert.deepEqual(lastOn(win, "updater:downloaded").payload, {
    version: "1.2.3",
  });

  au.emit("error", new Error("boom"));
  assert.deepEqual(lastOn(win, "updater:error").payload, {
    message: "boom",
    manual: false,
  });
});

test("a manual check threads manual:true into the lifecycle events", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });
  const win = fakeWindow();
  updater.initUpdater(() => win);

  updater.checkForUpdates({ manual: true });
  assert.equal(
    au.checkCalls,
    1,
    "delegates to autoUpdater on a packaged build",
  );

  au.emit("checking-for-update");
  assert.equal(lastOn(win, "updater:checking").payload.manual, true);
});

test("a dev build short-circuits without calling autoUpdater", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: false }, autoUpdater: au });
  const win = fakeWindow();
  updater.initUpdater(() => win);

  updater.checkForUpdates({ manual: true });
  assert.equal(
    au.checkCalls,
    0,
    "never touches the real updater on a dev build",
  );
  assert.deepEqual(lastOn(win, "updater:not-available").payload, {
    manual: true,
    reason: "dev-build",
  });
});

test("a rejected check is swallowed (the error event already reported it)", async () => {
  const au = fakeAutoUpdater({ checkRejects: true });
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });
  updater.initUpdater(() => fakeWindow());

  // Must not throw or surface an unhandled rejection.
  assert.doesNotThrow(() => updater.checkForUpdates({ manual: true }));
  await new Promise((r) => setTimeout(r, 0)); // let the rejection settle
});

test("quitAndInstall installs with the installer UI and relaunch flags", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });
  updater.initUpdater(() => fakeWindow());

  updater.quitAndInstall();
  assert.deepEqual(au.quitArgs, [false, true]);
});

test("electron-updater logging is routed into the injected logger", () => {
  const au = fakeAutoUpdater();
  updater._setTestHooks({ app: { isPackaged: true }, autoUpdater: au });
  const logs = [];
  const logger = {
    info: (tag, msg) => logs.push(["info", tag, msg]),
    warn: (tag, msg) => logs.push(["warn", tag, msg]),
    error: (tag, msg) => logs.push(["error", tag, msg]),
  };
  updater.initUpdater(() => fakeWindow(), logger);

  au.logger.warn("careful");
  assert.deepEqual(logs.at(-1), ["warn", "updater", "careful"]);
});
