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
 * tests/secure-file.test.js — the injected key reader (Feature 190).
 *
 * Off the Mac App Store it's a plain fs.readFileSync that never touches Electron's
 * `app`. On MAS it brackets the read with start/stop-accessing so a picked key
 * survives a relaunch, ALWAYS calling the stop function (even when the read
 * throws) so a scoped-resource grant can't leak, and evicting a stale bookmark so
 * a re-pick re-mints a fresh one. No real security-scoped bookmark API is invoked
 * — a fake `app` records the bracketing.
 */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { makeKeyReader } = require("../secure-file");

function tmpKey(contents = "PRIVATE-KEY-BYTES") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jumphippo-securefile-"));
  const file = path.join(dir, "id_rsa");
  fs.writeFileSync(file, contents);
  return { dir, file, contents };
}

// A fake Electron `app` that records every start/stop-accessing call.
function fakeApp({ startThrows = false } = {}) {
  const calls = { started: [], stopped: 0 };
  return {
    calls,
    startAccessingSecurityScopedResource(bookmark) {
      calls.started.push(bookmark);
      if (startThrows) throw new Error("bookmark invalidated");
      return () => {
        calls.stopped += 1;
      };
    },
  };
}

test("off MAS the reader is a plain read that never touches app", () => {
  const { dir, file, contents } = tmpKey();
  try {
    let bookmarkLookups = 0;
    const reader = makeKeyReader({
      app: {
        startAccessingSecurityScopedResource() {
          throw new Error("app must not be touched off MAS");
        },
      },
      getBookmark: () => {
        bookmarkLookups += 1;
        return "blob";
      },
      deleteBookmark: () => assert.fail("must not evict off MAS"),
      isMas: false,
    });
    assert.equal(reader(file).toString(), contents);
    assert.equal(bookmarkLookups, 0, "no bookmark lookup off MAS");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MAS with a bookmark brackets the read and always stops accessing", () => {
  const { dir, file, contents } = tmpKey();
  const app = fakeApp();
  try {
    let evicted = false;
    const reader = makeKeyReader({
      app,
      getBookmark: () => "the-blob",
      deleteBookmark: () => (evicted = true),
      isMas: true,
    });
    assert.equal(reader(file).toString(), contents);
    assert.deepEqual(app.calls.started, ["the-blob"]);
    assert.equal(app.calls.stopped, 1, "stop() called exactly once");
    assert.equal(evicted, false, "a good bookmark is never evicted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MAS with no bookmark reads directly, never touching app", () => {
  const { dir, file, contents } = tmpKey();
  const app = fakeApp();
  try {
    const reader = makeKeyReader({
      app,
      getBookmark: () => null,
      deleteBookmark: () => assert.fail("nothing to evict"),
      isMas: true,
    });
    assert.equal(reader(file).toString(), contents);
    assert.deepEqual(
      app.calls.started,
      [],
      "no start-accessing without a bookmark",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MAS stale bookmark (start-accessing throws) evicts and falls back to a plain read", () => {
  const { dir, file, contents } = tmpKey();
  const app = fakeApp({ startThrows: true });
  try {
    const evicted = [];
    const reader = makeKeyReader({
      app,
      getBookmark: () => "stale-blob",
      deleteBookmark: (p) => evicted.push(p),
      isMas: true,
    });
    // start-accessing throws → evict, then a plain read (which succeeds here, off
    // the real sandbox — in the sandbox it would fail and drop the auth method).
    assert.equal(reader(file).toString(), contents);
    assert.deepEqual(evicted, [file], "the stale bookmark is forgotten");
    assert.equal(app.calls.stopped, 0, "no grant to stop when start threw");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MAS grant OK but the file is gone: stop() still runs, entry evicted, error rethrown", () => {
  const { dir } = tmpKey();
  const missing = path.join(dir, "moved-away");
  const app = fakeApp();
  try {
    const evicted = [];
    const reader = makeKeyReader({
      app,
      getBookmark: () => "blob",
      deleteBookmark: (p) => evicted.push(p),
      isMas: true,
    });
    assert.throws(() => reader(missing), /ENOENT/);
    assert.deepEqual(app.calls.started, ["blob"]);
    assert.equal(
      app.calls.stopped,
      1,
      "stop() runs in finally even on a read throw",
    );
    assert.deepEqual(evicted, [missing], "the now-useless bookmark is evicted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a broken deleteBookmark never masks the read result", () => {
  const { dir } = tmpKey();
  const missing = path.join(dir, "gone");
  const app = fakeApp();
  try {
    const reader = makeKeyReader({
      app,
      getBookmark: () => "blob",
      deleteBookmark: () => {
        throw new Error("store write failed");
      },
      isMas: true,
    });
    // The original ENOENT surfaces, not the eviction failure.
    assert.throws(() => reader(missing), /ENOENT/);
    assert.equal(app.calls.stopped, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
