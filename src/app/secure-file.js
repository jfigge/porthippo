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
 * secure-file.js — the one place that touches Electron's security-scoped
 * bookmark API, so the tunnel engine stays Electron-free (Feature 190).
 *
 * `makeKeyReader` returns a `fs.readFileSync`-shaped `(filePath) => Buffer` that
 * main.js injects into the engine as its `keyReader`. Off the Mac App Store it IS
 * a plain `fs.readFileSync` — no bookmark lookup, `app` never touched. In the MAS
 * sandbox the user-selected grant on a picked key evaporates on quit, so the read
 * is bracketed by `app.startAccessingSecurityScopedResource(bookmark)` (which
 * re-enters the sandbox for exactly that file) and its paired stop function,
 * ALWAYS called in a `finally` so a scoped-resource grant can never leak.
 *
 * A missing bookmark reads directly (works off-sandbox; fails in the sandbox,
 * dropping the auth method exactly as before this feature). A stale/invalid
 * bookmark (file moved/deleted, blob invalidated) is EVICTED so a re-pick re-mints
 * a fresh one, then the read fails cleanly — never a crash, never an infinite
 * retry of a dead bookmark.
 */
"use strict";

const fs = require("fs");

/**
 * Build the injected key reader.
 *
 * @param {object} deps
 * @param {{ startAccessingSecurityScopedResource: (bookmark: string) => () => void }} [deps.app]
 *        Electron's `app` (MAS only). Never required off the sandbox.
 * @param {(filePath: string) => (string | null)} [deps.getBookmark]  look up the
 *        stored base64 bookmark for a path (KeyBookmarkStore.get).
 * @param {(filePath: string) => void} [deps.deleteBookmark]  evict a stale entry
 *        (KeyBookmarkStore.delete).
 * @param {boolean} [deps.isMas]  true in a Mac App Store build.
 * @returns {(filePath: string) => Buffer}
 */
function makeKeyReader({ app, getBookmark, deleteBookmark, isMas } = {}) {
  // Off the Mac App Store the reader is a byte-for-byte plain read: no bookmark
  // lookup, `app` untouched, no key-bookmarks.json written. (Also the fallback
  // when the wiring is incomplete — safest default.)
  if (!isMas || !app || typeof getBookmark !== "function") {
    return (filePath) => fs.readFileSync(filePath);
  }

  const evict = (filePath) => {
    try {
      deleteBookmark?.(filePath);
    } catch {
      // A failed eviction is never fatal — the read result stands.
    }
  };

  return (filePath) => {
    const bookmark = getBookmark(filePath);
    if (!bookmark) {
      // No durable grant — read directly. Works off-sandbox; in the sandbox this
      // throws (EPERM), dropping the auth method as it did before Feature 190.
      return fs.readFileSync(filePath);
    }

    let stop;
    try {
      stop = app.startAccessingSecurityScopedResource(bookmark);
    } catch {
      // The bookmark couldn't be resolved (invalidated / malformed): forget it so
      // a re-pick re-mints a fresh one, then fall through to a plain read.
      evict(filePath);
      return fs.readFileSync(filePath);
    }

    try {
      return fs.readFileSync(filePath);
    } catch (err) {
      // The grant resolved but the file is gone/unreadable (moved, deleted): evict
      // the now-useless bookmark so re-picking restores access, and let the read
      // failure drop the auth method as today.
      evict(filePath);
      throw err;
    } finally {
      // Never leak the scoped-resource grant, whatever the read did.
      if (typeof stop === "function") {
        try {
          stop();
        } catch {
          // Stopping an already-released grant is fine.
        }
      }
    }
  };
}

module.exports = { makeKeyReader };
