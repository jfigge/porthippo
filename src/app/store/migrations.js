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
 * migrations.js — Schema versioning & forward migration for stored documents.
 *
 * Every stored document (tunnels.json, settings.json, known-hosts.json, …)
 * carries a top-level integer `schemaVersion`. Documents written before this
 * field existed are treated as version `BASE_SCHEMA_VERSION` (1). `MIGRATIONS` is
 * an ordered list of pure, synchronous transforms; entry `i` upgrades a document
 * from version `i + BASE_SCHEMA_VERSION` to the next version.
 *
 * `migrate(doc)` runs every migration newer than the document's own version, then
 * stamps `CURRENT_SCHEMA_VERSION`. It is applied on the read path so in-memory
 * documents are always current; the upgraded shape is persisted lazily on the
 * next normal save (we do NOT eagerly rewrite files on load).
 *
 * Feature 10 ships schema v1, so `MIGRATIONS` is empty; later shape changes append
 * one type-guarded transform each (see Rest Hippo's migrations.js for the pattern).
 *
 * Rules for migration functions:
 *   - Pure and synchronous — no I/O, no mutation of the input (return a new object).
 *   - Each bumps the schema by exactly one version; `migrate` handles stamping.
 */
"use strict";

/** The version assumed for any document lacking a valid `schemaVersion`. */
const BASE_SCHEMA_VERSION = 1;

/**
 * Ordered migration functions. `MIGRATIONS[i]` upgrades a document from
 * version `i + BASE_SCHEMA_VERSION` to version `i + BASE_SCHEMA_VERSION + 1`.
 * Each is a pure `(doc) => doc` transform — no I/O, no input mutation.
 *
 * `migrate()` runs on EVERY stored document, so a future transform MUST be
 * type-guarded (inspect a discriminating field and pass unrelated shapes through
 * untouched).
 *
 * @type {Array<(doc: object) => object>}
 */
const MIGRATIONS = [];

/** The version every freshly written / migrated document is stamped with. */
const CURRENT_SCHEMA_VERSION = BASE_SCHEMA_VERSION + MIGRATIONS.length;

/**
 * Read a document's schema version, defaulting to `BASE_SCHEMA_VERSION` when the
 * field is absent or not a valid version integer.
 *
 * @param {*} doc
 * @returns {number}
 */
function schemaVersionOf(doc) {
  const v = doc && doc.schemaVersion;
  return Number.isInteger(v) && v >= BASE_SCHEMA_VERSION
    ? v
    : BASE_SCHEMA_VERSION;
}

/**
 * Upgrade a document to `CURRENT_SCHEMA_VERSION`, running every migration newer
 * than its current version, then stamping the current version.
 *
 * Non-object inputs (including `null`, e.g. a missing file) are returned as-is so
 * callers' missing-file defaults are unaffected. Documents already at the current
 * version with the field present are returned unchanged.
 *
 * @param {*} doc
 * @returns {*}
 */
function migrate(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return doc;
  }

  // Compute the target from MIGRATIONS.length rather than the cached constant so
  // production stays correct (empty list → target 1) while tests can append
  // migrations to exercise the forward chain.
  const target = BASE_SCHEMA_VERSION + MIGRATIONS.length;
  let version = schemaVersionOf(doc);

  if (version >= target) {
    // Already current: only allocate a copy if the field needs stamping.
    return doc.schemaVersion === version
      ? doc
      : { ...doc, schemaVersion: version };
  }

  let out = doc;
  for (let i = version - BASE_SCHEMA_VERSION; i < MIGRATIONS.length; i++) {
    out = MIGRATIONS[i](out);
    version += 1;
  }
  return { ...out, schemaVersion: target };
}

module.exports = {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersionOf,
  migrate,
};
