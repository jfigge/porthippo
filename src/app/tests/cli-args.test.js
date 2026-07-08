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

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("../cli-args");

test("parseArgs: no flags", () => {
  assert.deepEqual(parseArgs(["node", "main.js"]), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
});

test("parseArgs: --dev sets dev", () => {
  assert.equal(parseArgs(["node", "main.js", "--dev"]).dev, true);
});

test("parseArgs: --hot-reload sets hotReload", () => {
  assert.equal(parseArgs(["node", "main.js", "--hot-reload"]).hotReload, true);
});

test("parseArgs: --devtools sets devTools", () => {
  assert.equal(parseArgs(["node", "main.js", "--devtools"]).devTools, true);
});

test("parseArgs: --hot-reload does not imply devTools", () => {
  assert.equal(parseArgs(["node", "main.js", "--hot-reload"]).devTools, false);
});

test("parseArgs: all flags", () => {
  assert.deepEqual(parseArgs(["--dev", "--hot-reload", "--devtools"]), {
    dev: true,
    hotReload: true,
    devTools: true,
  });
});

test("parseArgs: defensive against missing/invalid argv", () => {
  assert.deepEqual(parseArgs(), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
  assert.deepEqual(parseArgs(null), {
    dev: false,
    hotReload: false,
    devTools: false,
  });
});
