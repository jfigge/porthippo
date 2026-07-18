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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Paths } = require("../paths");
const { KeyBookmarkStore } = require("../key-bookmark-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jumphippo-keybm-"));
  return {
    dir,
    paths: new Paths(dir),
    store: new KeyBookmarkStore(new Paths(dir)),
  };
}

test("set records a bookmark that get / list read back", () => {
  const { dir, store } = freshStore();
  try {
    assert.equal(store.get("/home/u/.ssh/id_rsa"), null);
    assert.deepEqual(store.list(), []);

    store.set("/home/u/.ssh/id_rsa", "Ym9va21hcms=");
    assert.equal(store.get("/home/u/.ssh/id_rsa"), "Ym9va21hcms=");
    assert.deepEqual(store.list(), [
      { path: "/home/u/.ssh/id_rsa", bookmark: "Ym9va21hcms=" },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set on the same path refreshes the stored bookmark (re-pick)", () => {
  const { dir, store } = freshStore();
  try {
    store.set("/k", "first");
    store.set("/k", "second");
    assert.equal(store.get("/k"), "second");
    assert.equal(store.list().length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bookmarks persist across a fresh store instance", () => {
  const { dir } = freshStore();
  try {
    new KeyBookmarkStore(new Paths(dir)).set("/k", "blob");
    assert.equal(new KeyBookmarkStore(new Paths(dir)).get("/k"), "blob");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete removes an entry and is idempotent", () => {
  const { dir, store } = freshStore();
  try {
    store.set("/k", "blob");
    assert.deepEqual(store.delete("/k"), { path: "/k", deleted: true });
    assert.equal(store.get("/k"), null);
    assert.deepEqual(store.delete("/k"), { path: "/k", deleted: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bad arguments are rejected", () => {
  const { dir, store } = freshStore();
  try {
    assert.throws(
      () => store.get(""),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.set("/k", ""),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.set(null, "blob"),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.delete(null),
      (e) => e.code === "INVALID_ARG",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt bookmark file degrades to empty (quarantined by io)", () => {
  const { dir, paths, store } = freshStore();
  try {
    fs.writeFileSync(paths.keyBookmarksPath(), "{ this is not json");
    // io.readJSON quarantines the corrupt file and reports it as missing, so the
    // store reads empty rather than throwing — access degrades to a re-pick.
    assert.equal(store.get("/k"), null);
    assert.deepEqual(store.list(), []);
    // And it can be written afresh afterwards.
    store.set("/k", "blob");
    assert.equal(store.get("/k"), "blob");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
