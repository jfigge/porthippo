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
 * definitions-doc.js — read/write the single definitions document that backs the
 * tunnel, credential and jump-host stores.
 *
 * Feature 45 promotes credentials and jump hosts to first-class, reusable records.
 * They live as sibling arrays in the SAME `tunnels.json` document
 * (`{ schemaVersion, tunnels, credentials, jumpHosts, groups }`) rather than
 * separate files, for one reason: the schema migration that extracts embedded auth
 * / inline jumps out of the old tunnel shape must be a single pure `(doc) => doc`
 * transform (migrations.js runs per-document and can't move data across files).
 * Feature 140 adds `groups` as a fourth sibling slice (organisational only — a
 * tunnel references at most one by `groupId`). Feature 200 adds `consoles` as a
 * fifth sibling slice — reusable interactive-shell targets that reference the same
 * `credentials` / `jumpHosts` a tunnel does.
 *
 * Each store reads the whole document, mutates only its own slice, and writes the
 * whole document back — safe because io.js writes are synchronous and therefore
 * serialized in this single-threaded process. These helpers centralise the shape
 * so a store can never accidentally drop a sibling array on write.
 */
"use strict";

const io = require("./io");

/**
 * Read the definitions document, normalised so every slice is an array.
 * @param {import('./paths').Paths} paths
 * @returns {{ tunnels: object[], credentials: object[], jumpHosts: object[],
 *   groups: object[], consoles: object[] }}
 */
function readDoc(paths) {
  const doc = io.readJSON(paths.tunnelsPath());
  return {
    tunnels: Array.isArray(doc?.tunnels) ? doc.tunnels : [],
    credentials: Array.isArray(doc?.credentials) ? doc.credentials : [],
    jumpHosts: Array.isArray(doc?.jumpHosts) ? doc.jumpHosts : [],
    groups: Array.isArray(doc?.groups) ? doc.groups : [],
    consoles: Array.isArray(doc?.consoles) ? doc.consoles : [],
  };
}

/**
 * Persist the definitions document, preserving all four slices. A partial `doc`
 * (only the slice a store changed) is filled out from `readDoc`-style defaults so
 * a caller can pass `{ ...current, tunnels: next }` without losing siblings.
 * @param {import('./paths').Paths} paths
 * @param {{ tunnels?: object[], credentials?: object[], jumpHosts?: object[],
 *   groups?: object[], consoles?: object[] }} doc
 */
function writeDoc(paths, doc) {
  io.writeJSON(paths.tunnelsPath(), {
    tunnels: Array.isArray(doc?.tunnels) ? doc.tunnels : [],
    credentials: Array.isArray(doc?.credentials) ? doc.credentials : [],
    jumpHosts: Array.isArray(doc?.jumpHosts) ? doc.jumpHosts : [],
    groups: Array.isArray(doc?.groups) ? doc.groups : [],
    consoles: Array.isArray(doc?.consoles) ? doc.consoles : [],
  });
}

module.exports = { readDoc, writeDoc };
