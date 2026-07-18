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
 * key-bookmark-store.js — machine-local security-scoped bookmarks for the
 * private-key files the user picks through the native open panel (Feature 190,
 * Mac App Store only).
 *
 * Under the App Sandbox the `files.user-selected.read-only` grant on a picked
 * key evaporates on quit, so on the next launch `ssh-chain.js` can't re-read the
 * stored PATH. Electron's `dialog.showOpenDialog({ securityScopedBookmarks: true })`
 * returns an app-scoped bookmark blob for the chosen URL; persisting it here lets
 * `secure-file.js` re-enter the sandbox for exactly that file on a later launch.
 *
 * Keyed by ABSOLUTE PATH (not credential id): two credentials pointing at the
 * same key share one grant, and re-picking the same path refreshes it. The blob
 * is an OS access token to a path — NOT a secret value — but it is machine-local:
 * never exported in a `.jumphippo` bundle, never logged. Persisted as
 * `{ schemaVersion, bookmarks: { "<absPath>": "<base64>" } }`; a corrupt file is
 * quarantined by `io.readJSON` and treated as empty (access degrades to a re-pick).
 */
"use strict";

const io = require("./io");

function requirePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    const err = new Error("path must be a non-empty string");
    err.code = "INVALID_ARG";
    throw err;
  }
}

class KeyBookmarkStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    const doc = io.readJSON(this._paths.keyBookmarksPath());
    return doc && typeof doc.bookmarks === "object" && doc.bookmarks !== null
      ? doc.bookmarks
      : {};
  }

  _write(bookmarks) {
    io.writeJSON(this._paths.keyBookmarksPath(), { bookmarks });
  }

  /** The base64 bookmark blob for `filePath`, or null when none is stored. */
  get(filePath) {
    requirePath(filePath);
    return this._read()[filePath] ?? null;
  }

  /**
   * Record (or replace) the bookmark for `filePath`. Re-picking the same key
   * refreshes its grant.
   * @param {string} filePath  absolute path to the private key
   * @param {string} bookmark  base64 security-scoped bookmark blob
   */
  set(filePath, bookmark) {
    requirePath(filePath);
    if (typeof bookmark !== "string" || bookmark.length === 0) {
      const err = new Error("bookmark must be a non-empty string");
      err.code = "INVALID_ARG";
      throw err;
    }
    const bookmarks = this._read();
    bookmarks[filePath] = bookmark;
    this._write(bookmarks);
    return { path: filePath };
  }

  /**
   * Forget the bookmark for `filePath` (a stale/invalid blob self-heals this way,
   * so a re-pick re-mints a fresh one). Idempotent — deleting an absent entry is
   * a no-op.
   * @param {string} filePath
   * @returns {{ path: string, deleted: boolean }}
   */
  delete(filePath) {
    requirePath(filePath);
    const bookmarks = this._read();
    const deleted = Object.prototype.hasOwnProperty.call(bookmarks, filePath);
    if (deleted) {
      delete bookmarks[filePath];
      this._write(bookmarks);
    }
    return { path: filePath, deleted };
  }

  /** All stored bookmarks as `[{ path, bookmark }]`. */
  list() {
    const bookmarks = this._read();
    return Object.entries(bookmarks).map(([filePath, bookmark]) => ({
      path: filePath,
      bookmark,
    }));
  }
}

module.exports = { KeyBookmarkStore };
