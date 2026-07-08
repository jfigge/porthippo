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
 * i18n.js (main process) — loads locale catalogs from `src/web/locales/` and
 * resolves labels for chrome the main process renders itself (the application
 * menu, the tray, and native dialogs/notifications), which can't reach the
 * renderer's `t()`. The `i18n:load` IPC handler hands the resolved catalog to
 * the renderer, which layers it over its embedded English (see web/scripts/i18n.js).
 *
 * Resolution order: the persisted `requested` language (unless "system") → the OS
 * `systemLocale` → English. English is always loaded as the fallback so a locale
 * that omits a key still resolves. `readCatalog` validates the language subtag
 * BEFORE touching the filesystem, so a crafted value can't traverse out of the
 * locales directory.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "web", "locales");

/**
 * Read and parse one locale catalog by language subtag. Returns null on any
 * failure (missing file, bad JSON, or an invalid subtag).
 * @param {string} lang  a 2–3 letter language subtag, e.g. "en"
 * @returns {object|null}
 */
function readCatalog(lang) {
  // Path-traversal guard: only bare language subtags reach the filesystem.
  if (typeof lang !== "string" || !/^[a-z]{2,3}$/i.test(lang)) return null;
  try {
    const file = path.join(LOCALES_DIR, `${lang.toLowerCase()}.json`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve and load the active catalog plus the English fallback.
 * @param {object} opts
 * @param {string} [opts.requested]     persisted language ("system" or a subtag)
 * @param {string} [opts.systemLocale]  the OS locale (e.g. app.getLocale())
 * @returns {{requested:string, system:string|null, active:string, lang:string,
 *            messages:object, fallback:object}}
 */
function loadCatalog({ requested, systemLocale } = {}) {
  const english = readCatalog("en") || {};
  const wants =
    requested && requested !== "system" ? requested : systemLocale || "";
  const subtag = wants ? String(wants).split("-")[0].toLowerCase() : "en";

  let messages = english;
  let active = "en";
  if (subtag && subtag !== "en") {
    const cat = readCatalog(subtag);
    if (cat) {
      messages = cat;
      active = subtag;
    }
  }

  return {
    requested: requested || "system",
    system: systemLocale || null,
    active,
    lang: active.split("-")[0],
    messages,
    fallback: english,
  };
}

function lookup(catalog, key) {
  if (!catalog) return undefined;
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  let node = catalog;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in node) node = node[part];
    else return undefined;
  }
  return node;
}

/**
 * Resolve a label from a loaded catalog: active messages → English fallback →
 * the provided literal fallback → the key. No interpolation (use `format`).
 * @param {object} catalog  a `loadCatalog()` result
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
function label(catalog, key, fallback) {
  const hit = lookup(catalog && catalog.messages, key);
  if (typeof hit === "string") return hit;
  const fb = lookup(catalog && catalog.fallback, key);
  if (typeof fb === "string") return fb;
  return fallback !== undefined ? fallback : key;
}

/**
 * Interpolate `{name}` placeholders (main-side, since `label` doesn't).
 * @param {string} str
 * @param {Object<string,any>} [params]
 * @returns {string}
 */
function format(str, params) {
  if (!params) return String(str);
  return String(str).replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : m,
  );
}

module.exports = { LOCALES_DIR, readCatalog, loadCatalog, label, format };
