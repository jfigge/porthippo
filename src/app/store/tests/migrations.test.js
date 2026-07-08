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

const {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersionOf,
  migrate,
} = require("../migrations");

test("Feature 10 ships schema v1 with an empty migration chain", () => {
  assert.equal(BASE_SCHEMA_VERSION, 1);
  assert.equal(MIGRATIONS.length, 0);
  assert.equal(CURRENT_SCHEMA_VERSION, 1);
});

test("migrate stamps the current version on an object document", () => {
  assert.deepEqual(migrate({ tunnels: [] }), {
    tunnels: [],
    schemaVersion: 1,
  });
});

test("migrate leaves an already-current document untouched (same ref)", () => {
  const doc = { schemaVersion: 1, a: 1 };
  assert.equal(migrate(doc), doc);
});

test("migrate passes non-object inputs through unchanged", () => {
  assert.equal(migrate(null), null);
  assert.equal(migrate("plain"), "plain");
  assert.equal(migrate(7), 7);
  const arr = [1, 2, 3];
  assert.equal(migrate(arr), arr); // arrays are not stamped
});

test("schemaVersionOf defaults to the base version when absent/invalid", () => {
  assert.equal(schemaVersionOf({}), 1);
  assert.equal(schemaVersionOf({ schemaVersion: "x" }), 1);
  assert.equal(schemaVersionOf({ schemaVersion: 3 }), 3);
  assert.equal(schemaVersionOf(null), 1);
});
