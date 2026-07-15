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

// slugify.js — the ONE heading-slug transform, shared so the in-app DocsViewer
// and the website build (scripts/build-docs.mjs) can never drift. Both render the
// same Markdown, so an author-written `#fragment` link must resolve to the same id
// in each; keeping a single implementation makes that structural rather than a
// convention two copies have to honour. (build-docs decodes entities / strips tags
// first because it slugs raw heading markup; DocsViewer slugs already-parsed text.
// The core below is identical for both.)
"use strict";

/**
 * GitHub-style heading slug for PLAIN text (entities/tags already resolved by the
 * caller): lowercase, trim, drop punctuation, collapse whitespace RUNS to a single
 * hyphen, then coalesce any resulting hyphen runs.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return (text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
