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

test("a shipped locale resolves to its own catalog (Feature 180)", () => {
  // fr.json now ships, so "fr" resolves to French — not the English fallback.
  const cat = loadCatalog({ requested: "fr", systemLocale: "en-US" });
  assert.equal(cat.active, "fr");
  assert.equal(cat.lang, "fr");
  assert.equal(cat.requested, "fr");
  assert.equal(cat.messages["state.connected"], "Connecté");
  // English is still loaded as the fallback for any key a locale might omit.
  assert.equal(cat.fallback["state.connected"], "Connected");
});

test("every shipped locale loads its own catalog, not English", () => {
  for (const lang of ["de", "es", "zh", "ja", "it"]) {
    const cat = loadCatalog({ requested: lang, systemLocale: "en-US" });
    assert.equal(cat.active, lang, `${lang} should resolve to itself`);
    assert.equal(cat.lang, lang);
    // Proves the locale's own catalog loaded, not the English fallback.
    assert.notEqual(cat.messages["state.connected"], "Connected");
  }
});

test("an unshipped locale falls back to English but reports its request", () => {
  // No pt.json ships, so "pt" resolves to English while reporting the request.
  const cat = loadCatalog({ requested: "pt", systemLocale: "en-US" });
  assert.equal(cat.active, "en");
  assert.equal(cat.requested, "pt");
  assert.equal(cat.messages["common.cancel"], "Cancel");
});

test("system locale selects a shipped catalog by its primary subtag", () => {
  // "System default" on a machine whose OS locale is one of the six lands there;
  // zh-Hans / zh-CN etc. all key on the primary "zh" subtag.
  const ja = loadCatalog({ requested: "system", systemLocale: "ja-JP" });
  assert.equal(ja.active, "ja");
  const zh = loadCatalog({ requested: "system", systemLocale: "zh-Hans-CN" });
  assert.equal(zh.active, "zh");
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
