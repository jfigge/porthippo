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

import { resetDom } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  t,
  formatNumber,
  formatDate,
  applyCatalog,
  getLocale,
  getLang,
  EN,
} from "../i18n.js";

const readWeb = (rel) =>
  fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// applyCatalog mutates shared module state; reset to embedded English + a fresh
// DOM before each test so ordering can't leak a catalog between cases.
function reset() {
  resetDom();
  applyCatalog(); // → embedded EN, active "en"
}

test("the embedded English catalog resolves synchronously (no init)", () => {
  reset();
  assert.equal(t("def.list.arm"), "Arm");
  assert.equal(t("mon.pause"), "Pause");
  assert.equal(t("state.connected"), "Connected");
});

test("interpolates {placeholder} tokens, leaving unmatched ones intact", () => {
  reset();
  assert.equal(
    t("def.list.summary", { localPort: 5432, host: "db", port: 6543 }),
    "localhost:5432 → db:6543",
  );
  assert.equal(t("mon.rateUp", {}), "▲ {rate}"); // unmatched left as-is
});

test("resolution order is active → English fallback → key", () => {
  reset();
  applyCatalog({
    active: "es",
    lang: "es",
    messages: { "common.cancel": "Cancelar" }, // partial: only one key
    fallback: EN,
  });
  assert.equal(t("common.cancel"), "Cancelar"); // from active
  assert.equal(t("common.save"), "Save"); // from English fallback
  assert.equal(t("no.such.key"), "no.such.key"); // neither → the key itself
});

test("plural forms select by numeric count, including via fallback", () => {
  reset();
  applyCatalog({
    active: "en",
    lang: "en",
    messages: { "x.items": { one: "{count} item", other: "{count} items" } },
    fallback: EN,
  });
  assert.equal(t("x.items", { count: 1 }), "1 item");
  assert.equal(t("x.items", { count: 3 }), "3 items");
});

test("a group node with no count returns the key", () => {
  reset();
  applyCatalog({
    active: "en",
    lang: "en",
    messages: { group: { child: "value" } },
    fallback: {},
  });
  assert.equal(t("group"), "group");
  assert.equal(t("group.child"), "value"); // dotted walk still resolves leaves
});

test("formatNumber and formatDate follow the active locale", () => {
  reset();
  assert.equal(formatNumber(1234.5), "1,234.5");
  assert.equal(formatDate("not-a-date"), "");
  assert.ok(formatDate(new Date("2026-07-08T12:00:00Z")).length > 0);
});

test("applyCatalog sets the locale, lang and <html lang>", () => {
  reset();
  applyCatalog({ active: "en-GB", messages: {}, fallback: {} });
  assert.equal(getLocale(), "en-GB");
  assert.equal(getLang(), "en"); // region stripped for the lang subtag
  assert.equal(document.documentElement.lang, "en");
});

test("an empty catalog passes keys through unchanged", () => {
  reset();
  applyCatalog({ active: "xx", messages: {}, fallback: {} });
  assert.equal(t("anything.at.all"), "anything.at.all");
});

test("locales/en.json is byte-identical to the embedded EN catalog", () => {
  const enJson = JSON.parse(readWeb("../../locales/en.json"));
  assert.deepEqual(
    Object.keys(enJson).sort(),
    Object.keys(EN).sort(),
    "en.json and EN key sets differ — regenerate en.json from EN",
  );
  for (const key of Object.keys(EN)) {
    assert.deepEqual(enJson[key], EN[key], `value mismatch at "${key}"`);
  }
});

test("every shipped locale is in parity with EN (keys, shape, placeholders)", () => {
  // Feature 180: a translation is values-only. Each locale MUST carry EN's exact
  // key set, keep every value's shape (a string stays a string; a plural group
  // stays an object with the same form keys), and preserve each value's set of
  // {placeholder} tokens. Runtime still falls back to English for a gap — this
  // test forbids SHIPPING one, so a translation can never silently drift from EN.
  const localesDir = fileURLToPath(new URL("../../locales", import.meta.url));
  const files = fs
    .readdirSync(localesDir)
    .filter((f) => f.endsWith(".json") && f !== "en.json")
    .sort();
  assert.ok(files.length > 0, "no locale catalogs found to check");

  const enKeys = Object.keys(EN);
  const enKeySet = new Set(enKeys);

  // Order-independent set of {placeholder} token names reachable from a value —
  // a plain string, or the union across a plural group's string forms.
  const tokens = (v) => {
    const strs = v && typeof v === "object" ? Object.values(v) : [v];
    return new Set(
      strs.flatMap((s) =>
        [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]),
      ),
    );
  };
  // Structural signature: "string", or the sorted plural-form keys of a group.
  const shape = (v) =>
    v && typeof v === "object" ? Object.keys(v).sort().join(",") : typeof v;
  const sorted = (set) => [...set].sort();

  for (const file of files) {
    const lang = file.replace(/\.json$/, "");
    const cat = JSON.parse(readWeb(`../../locales/${file}`));

    // (1) Key set equals EN's — no missing, no extra.
    const missing = enKeys.filter((k) => !(k in cat));
    const extra = Object.keys(cat).filter((k) => !enKeySet.has(k));
    assert.deepEqual(missing, [], `${lang}.json is missing keys: ${missing}`);
    assert.deepEqual(extra, [], `${lang}.json has unknown keys: ${extra}`);

    // (2) shape parity + (3) {placeholder}-token parity, per key.
    for (const key of enKeys) {
      assert.equal(
        shape(cat[key]),
        shape(EN[key]),
        `${lang}.json shape mismatch at "${key}"`,
      );
      assert.deepEqual(
        sorted(tokens(cat[key])),
        sorted(tokens(EN[key])),
        `${lang}.json placeholder-token mismatch at "${key}"`,
      );
    }
  }
});

test('every literal t("…") key used in the renderer exists in EN', () => {
  // Walk the renderer source (excluding tests, vendored third-party bundles, and
  // the i18n module itself).
  const root = fileURLToPath(new URL("../../scripts", import.meta.url));
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "tests" && entry.name !== "vendor") walk(p);
      } else if (entry.name.endsWith(".js") && entry.name !== "i18n.js") {
        files.push(p);
      }
    }
  };
  walk(root);

  const missing = [];
  const re = /\bt\(\s*["']([^"']+)["']/g;
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(src)) !== null) {
      if (!Object.prototype.hasOwnProperty.call(EN, m[1])) {
        missing.push(`${file.split("/").pop()} → ${m[1]}`);
      }
    }
  }
  assert.deepEqual(missing, [], `renderer keys missing from EN: ${missing}`);
});
