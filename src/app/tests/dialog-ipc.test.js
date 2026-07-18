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
 * tests/dialog-ipc.test.js — the private-key open-panel contract (Feature 40 +
 * 190). The picker requests a security-scoped bookmark; when Electron returns one
 * (MAS) it is persisted keyed by absolute path and the handler reports
 * `remembered: true`. Off the sandbox no bookmark comes back, so `remembered` is
 * false and no bookmark is stored. A cancel resolves null. Uses a fake ipcMain +
 * dialog + bookmark store; no Electron process is started.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { registerDialogIPC } = require("../ipc/dialog");

function harness({ dialogResult, store, isMas = false, bookmarks = {} } = {}) {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  let showOpenArgs = null;
  const dialog = {
    showOpenDialog: async (_parent, opts) => {
      showOpenArgs = opts;
      return dialogResult;
    },
  };
  const saved = [];
  const bookmarkStore = store || {
    set: (path, bookmark) => saved.push({ path, bookmark }),
    get: (path) => bookmarks[path] ?? null,
  };
  registerDialogIPC({
    ipcMain,
    dialog,
    getMainWindow: () => null,
    getKeyBookmarkStore: () => bookmarkStore,
    isMas,
  });
  return {
    open: handlers.get("dialog:open-key-file"),
    keyStatus: handlers.get("dialog:key-status"),
    saved,
    getShowOpenArgs: () => showOpenArgs,
  };
}

test("the picker always requests a security-scoped bookmark", async () => {
  const { open, getShowOpenArgs } = harness({
    dialogResult: { canceled: false, filePaths: ["/k"], bookmarks: [] },
  });
  await open();
  assert.equal(getShowOpenArgs().securityScopedBookmarks, true);
});

test("a defaultPath opens the panel at the current key; omitting it leaves it unset", async () => {
  const { open, getShowOpenArgs } = harness({
    dialogResult: { canceled: false, filePaths: ["/k"], bookmarks: [] },
  });
  await open(null, { defaultPath: "/Users/u/.ssh/id_rsa" });
  assert.equal(getShowOpenArgs().defaultPath, "/Users/u/.ssh/id_rsa");
  await open(); // no request payload
  assert.equal(getShowOpenArgs().defaultPath, undefined);
  await open(null, { defaultPath: "" }); // blank is ignored
  assert.equal(getShowOpenArgs().defaultPath, undefined);
});

test("a returned bookmark is persisted and reported as remembered (MAS)", async () => {
  const { open, saved } = harness({
    dialogResult: {
      canceled: false,
      filePaths: ["/Users/u/.ssh/id_rsa"],
      bookmarks: ["Ym9va21hcms="],
    },
  });
  const result = await open();
  assert.deepEqual(result, {
    path: "/Users/u/.ssh/id_rsa",
    remembered: true,
  });
  // Keyed by absolute path, persisted before the credential is even saved.
  assert.deepEqual(saved, [
    { path: "/Users/u/.ssh/id_rsa", bookmark: "Ym9va21hcms=" },
  ]);
});

test("no bookmark returned (direct build): path returned, remembered false, nothing stored", async () => {
  const { open, saved } = harness({
    dialogResult: { canceled: false, filePaths: ["/k"], bookmarks: [] },
  });
  const result = await open();
  assert.deepEqual(result, { path: "/k", remembered: false });
  assert.deepEqual(saved, [], "no bookmark stored off the sandbox");
});

test("a cancelled pick resolves null and stores nothing", async () => {
  const { open, saved } = harness({
    dialogResult: { canceled: true, filePaths: [] },
  });
  assert.equal(await open(), null);
  assert.deepEqual(saved, []);
});

test("a failing bookmark store degrades to remembered:false without throwing", async () => {
  const { open } = harness({
    dialogResult: {
      canceled: false,
      filePaths: ["/k"],
      bookmarks: ["blob"],
    },
    store: {
      set() {
        throw new Error("disk full");
      },
    },
  });
  // The path is still usable this session; only the durable grant is lost.
  const result = await open();
  assert.deepEqual(result, { path: "/k", remembered: false });
});

// ── dialog:key-status — the re-pick nudge (Feature 190) ───────────────────────

test("key-status: off MAS a stored key never needs a re-pick", () => {
  const { keyStatus } = harness({ isMas: false, bookmarks: {} });
  assert.deepEqual(keyStatus(null, { path: "/Users/u/.ssh/id_rsa" }), {
    needsRepick: false,
  });
});

test("key-status: on MAS a bookmarked key does not need a re-pick", () => {
  const { keyStatus } = harness({
    isMas: true,
    bookmarks: { "/Users/u/.ssh/id_rsa": "blob" },
  });
  assert.deepEqual(keyStatus(null, { path: "/Users/u/.ssh/id_rsa" }), {
    needsRepick: false,
  });
});

test("key-status: on MAS a key with NO bookmark needs a re-pick", () => {
  const { keyStatus } = harness({ isMas: true, bookmarks: {} });
  assert.deepEqual(keyStatus(null, { path: "/Users/u/.ssh/id_rsa" }), {
    needsRepick: true,
  });
});

test("key-status: a blank / missing path never nudges", () => {
  const { keyStatus } = harness({ isMas: true, bookmarks: {} });
  assert.deepEqual(keyStatus(null, { path: "" }), { needsRepick: false });
  assert.deepEqual(keyStatus(null, {}), { needsRepick: false });
});

test("key-status: a throwing bookmark store fails safe to needsRepick:true", () => {
  const { keyStatus } = harness({
    isMas: true,
    store: {
      get() {
        throw new Error("store read failed");
      },
    },
  });
  assert.deepEqual(keyStatus(null, { path: "/k" }), { needsRepick: true });
});
