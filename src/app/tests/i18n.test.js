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

const { readCatalog, loadCatalog, label, format } = require("../i18n");

// NOTE: the "en.json is byte-identical to EN" and "every renderer t() key exists"
// completeness guards live in web/scripts/tests/i18n.test.js, where EN is a plain
// ESM import (no CJS→ESM dynamic-import warning).

test("loadCatalog defaults to English for system / undefined / en", () => {
  for (const requested of [undefined, "system", "en"]) {
    const cat = loadCatalog({ requested, systemLocale: "en-US" });
    assert.equal(cat.active, "en");
    assert.equal(cat.lang, "en");
    assert.equal(cat.messages["common.cancel"], "Cancel");
    assert.equal(cat.fallback["common.cancel"], "Cancel");
  }
});

test("a requested locale with no catalog falls back to English", () => {
  // No fr.json ships yet, so "fr" resolves to English but reports its request.
  const cat = loadCatalog({ requested: "fr", systemLocale: "en-US" });
  assert.equal(cat.active, "en");
  assert.equal(cat.requested, "fr");
  assert.equal(cat.messages["common.cancel"], "Cancel");
});

test("system locale is used when no explicit language is set", () => {
  // "zz" is not a shipped catalog → English, but the system value is reported.
  const cat = loadCatalog({ requested: "system", systemLocale: "zz-ZZ" });
  assert.equal(cat.system, "zz-ZZ");
  assert.equal(cat.active, "en");
});

test("readCatalog loads by subtag and rejects path-traversal attempts", () => {
  assert.ok(readCatalog("en")); // real catalog
  for (const bad of ["../../package", "en/../en", "", null, "english-long"]) {
    assert.equal(readCatalog(bad), null);
  }
});

test("label resolves active → fallback → literal → key; format interpolates", () => {
  const cat = loadCatalog({ requested: "en" });
  assert.equal(label(cat, "common.cancel"), "Cancel");
  assert.equal(label(cat, "no.such.key", "Literal"), "Literal");
  assert.equal(label(cat, "no.such.key"), "no.such.key");
  assert.equal(
    format(label(cat, "tray.tooltip"), { active: 1, total: 3 }),
    "Port Hippo — 1 of 3 active",
  );
});
