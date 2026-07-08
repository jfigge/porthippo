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
 * tests/secret-storage-ipc.test.js — the Feature 90 secret-storage IPC contract:
 * every channel returns the documented { ok, reason?, … } / state shape, and a
 * successful unlock / mode switch reconciles the engine and broadcasts, while a
 * refusal or a no-op does neither. Wires the real registerSecretStorageIPC to a
 * real SecretStorage over a temp profile, with a fake ipcMain / engine / broadcast.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const crypto = require("../store/crypto");
const { Paths } = require("../store/paths");
const { SecretStorage } = require("../store/secret-storage");
const { registerSecretStorageIPC } = require("../ipc/secret-storage");

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-ssipc-"));
  const sec = new SecretStorage(new Paths(dir));
  sec.bootstrap(); // app-key on a keystore-less test platform

  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const engineCalls = [];
  const getEngine = () => ({
    reconcileAll: async () => {
      engineCalls.push("reconcile");
    },
  });
  const broadcasts = [];
  const broadcast = (channel, payload) => broadcasts.push({ channel, payload });
  const safeCall = (_channel, fn, fallback = null) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  registerSecretStorageIPC({
    ipcMain,
    getStores: () => ({ secretStorage: () => sec }),
    getEngine,
    broadcast,
    safeCall,
  });

  return {
    dir,
    engineCalls,
    broadcasts,
    invoke: (channel, arg) => handlers.get(channel)(null, arg),
  };
}

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test("get-mode returns the { mode, locked, available, hasPassword } shape", () => {
  const { dir, invoke } = harness();
  try {
    const s = invoke("secret-storage:get-mode");
    assert.deepEqual(Object.keys(s).sort(), [
      "available",
      "hasPassword",
      "locked",
      "mode",
    ]);
    assert.equal(s.mode, "app-key");
    assert.equal(s.locked, false);
    assert.equal(typeof s.available, "boolean");
    assert.equal(s.hasPassword, false);
  } finally {
    cleanup(dir);
  }
});

test("set-mode rejects an invalid mode with a reason and no side effects", () => {
  const { dir, invoke, engineCalls, broadcasts } = harness();
  try {
    assert.deepEqual(invoke("secret-storage:set-mode", { mode: "bogus" }), {
      ok: false,
      reason: "invalid-mode",
    });
    assert.equal(engineCalls.length, 0);
    assert.equal(broadcasts.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("set-mode to the current mode is unchanged and fires no reconcile", () => {
  const { dir, invoke, engineCalls, broadcasts } = harness();
  try {
    assert.deepEqual(invoke("secret-storage:set-mode", { mode: "app-key" }), {
      ok: true,
      unchanged: true,
    });
    assert.equal(engineCalls.length, 0);
    assert.equal(broadcasts.length, 0);
  } finally {
    cleanup(dir);
  }
});

test("set-mode to master-password without a password reports password-required", () => {
  const { dir, invoke } = harness();
  try {
    assert.deepEqual(
      invoke("secret-storage:set-mode", { mode: "master-password" }),
      { ok: false, reason: "password-required" },
    );
  } finally {
    cleanup(dir);
  }
});

test("a successful mode switch reconciles the engine and broadcasts the new state", () => {
  const { dir, invoke, engineCalls, broadcasts } = harness();
  try {
    const res = invoke("secret-storage:set-mode", {
      mode: "master-password",
      password: "hunter2",
    });
    assert.deepEqual(res, { ok: true });
    assert.equal(engineCalls.length, 1);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].channel, "porthippo:secret-storage-changed");
    assert.equal(broadcasts[0].payload.mode, "master-password");
    assert.equal(broadcasts[0].payload.locked, false);
    assert.equal(broadcasts[0].payload.hasPassword, true);
  } finally {
    cleanup(dir);
  }
});

test("unlock rejects a wrong password and accepts the right one", () => {
  const { dir, invoke, engineCalls } = harness();
  try {
    invoke("secret-storage:set-mode", {
      mode: "master-password",
      password: "hunter2",
    });
    invoke("secret-storage:lock");
    const before = engineCalls.length;

    assert.deepEqual(invoke("secret-storage:unlock", { password: "nope" }), {
      ok: false,
      reason: "bad-password",
    });
    assert.equal(
      engineCalls.length,
      before,
      "a failed unlock reconciles nothing",
    );

    assert.deepEqual(invoke("secret-storage:unlock", { password: "hunter2" }), {
      ok: true,
    });
    assert.equal(engineCalls.length, before + 1);
  } finally {
    cleanup(dir);
  }
});

test("lock returns { ok } and broadcasts without reconciling", () => {
  const { dir, invoke, engineCalls, broadcasts } = harness();
  try {
    invoke("secret-storage:set-mode", {
      mode: "master-password",
      password: "hunter2",
    });
    const engineBefore = engineCalls.length;
    const bcBefore = broadcasts.length;

    assert.deepEqual(invoke("secret-storage:lock"), { ok: true });
    assert.equal(engineCalls.length, engineBefore, "lock reconciles nothing");
    assert.equal(broadcasts.length, bcBefore + 1);
  } finally {
    cleanup(dir);
  }
});
