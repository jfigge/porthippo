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
const { SettingsStore, DEFAULTS } = require("../settings-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-settings-"));
  return { dir, store: new SettingsStore(new Paths(dir)) };
}

test("get returns the defaults when nothing is stored", () => {
  const { dir, store } = freshStore();
  try {
    assert.deepEqual(store.get(), { ...DEFAULTS });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set shallow-merges a patch and leaves other defaults intact", () => {
  const { dir, store } = freshStore();
  try {
    const next = store.set({ theme: "dark" });
    assert.equal(next.theme, "dark");
    assert.equal(next.defaultBindHost, DEFAULTS.defaultBindHost);
    assert.equal(store.get().theme, "dark");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings persist across a fresh store instance", () => {
  const { dir } = freshStore();
  try {
    new SettingsStore(new Paths(dir)).set({
      launchAtLogin: true,
      defaultLingerMs: 500,
    });
    const reread = new SettingsStore(new Paths(dir)).get();
    assert.equal(reread.launchAtLogin, true);
    assert.equal(reread.defaultLingerMs, 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the internal schemaVersion stamp is not exposed in the view", () => {
  const { dir, store } = freshStore();
  try {
    store.set({ theme: "light" });
    assert.equal("schemaVersion" in store.get(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the Feature 60 behaviour keys default and round-trip", () => {
  const { dir, store } = freshStore();
  try {
    // Defaults are present in the view.
    const defaults = store.get();
    assert.equal(defaults.language, "system");
    assert.equal(defaults.defaultKeepAlive, false);
    assert.equal(defaults.startMinimized, false);
    assert.equal(defaults.armOnLaunch, true);
    assert.equal(defaults.confirmOnQuit, false);

    // And a patch of the new keys persists across a fresh instance.
    store.set({
      language: "fr",
      startMinimized: true,
      armOnLaunch: false,
      confirmOnQuit: true,
      defaultKeepAlive: true,
    });
    const reread = new SettingsStore(new Paths(dir)).get();
    assert.equal(reread.language, "fr");
    assert.equal(reread.startMinimized, true);
    assert.equal(reread.armOnLaunch, false);
    assert.equal(reread.confirmOnQuit, true);
    assert.equal(reread.defaultKeepAlive, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-object patch is rejected", () => {
  const { dir, store } = freshStore();
  try {
    assert.throws(
      () => store.set(null),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.set([]),
      (e) => e.code === "INVALID_ARG",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
