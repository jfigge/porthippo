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

// slugify.test.js — the docs heading-slug contract, and the parity guard that once
// failed silently: build-docs.mjs (website) and DocsViewer (in-app) must produce
// IDENTICAL heading ids so an author's `#fragment` link resolves in both. They now
// share utils/slugify.js; this test locks in the transform AND asserts build-docs's
// raw-markup wrapper folds down to the same shared core.

import { test } from "node:test";
import assert from "node:assert/strict";

import { slugify } from "../utils/slugify.js";
import { slugifyHeading } from "../../../../scripts/build-docs.mjs";

// Real headings from the guide plus other whitespace/punctuation shapes. The first
// two are exactly what regressed when build-docs used /\s/ (per-char) while the
// viewer used /\s+/ (collapsed): punctuation between spaces left a double hyphen.
const HEADINGS = [
  "Arm / disarm controls",
  '"Host key changed" — refused connection',
  "Getting Started",
  "Host Keys & Trust",
  "Monitoring  &  Pause",
  "trailing spaces   ",
  "Tabs\tand\nnewlines",
  "already-hyphenated",
  "",
];

test("slugify collapses whitespace and hyphen runs (the shared contract)", () => {
  assert.equal(slugify("Arm / disarm controls"), "arm-disarm-controls");
  assert.equal(
    slugify('"Host key changed" — refused connection'),
    "host-key-changed-refused-connection",
  );
  assert.equal(slugify("Host Keys & Trust"), "host-keys-trust");
  assert.equal(slugify("Monitoring  &  Pause"), "monitoring-pause");
  assert.equal(slugify("Tabs\tand\nnewlines"), "tabs-and-newlines");
  assert.equal(slugify(""), "");
  assert.equal(slugify(null), "");
});

test("build-docs slugifyHeading matches the shared slugify on plain text", () => {
  for (const h of HEADINGS) {
    assert.equal(
      slugifyHeading(h),
      slugify(h),
      `slug diverged on: ${JSON.stringify(h)}`,
    );
  }
});

test("build-docs slugifyHeading strips tags and decodes entities into the same id", () => {
  // Its extra responsibility (it slugs raw heading markup) still folds to the id
  // the viewer produces from the parsed text.
  assert.equal(slugifyHeading("Host Keys &amp; Trust"), "host-keys-trust");
  assert.equal(slugifyHeading("Arm <code>/</code> disarm"), "arm-disarm");
  assert.equal(slugifyHeading("A &lt;b&gt; tag"), "a-b-tag");
});
