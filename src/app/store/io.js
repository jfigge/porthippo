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
 * io.js — Low-level filesystem primitives for the main-process storage layer.
 *
 * All writes use a write-to-tmp-then-rename pattern for atomicity, with an fsync
 * of both the file and its directory so a rename survives a crash. Writes are
 * synchronous, which makes them inherently serialized in this single-threaded
 * process (there is no separate async write queue to reason about). Path/ID
 * helpers prevent directory traversal.
 *
 * Ported from Rest Hippo's storage layer (src/app/store/io.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { migrate } = require("./migrations");

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Ensure a directory (and parents) exist.
 * @param {string} dir
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Temp-file naming & in-flight tracking ──────────────────────────────────────

/**
 * Distinctive infix marking write temp files. Real data files never contain it,
 * so the startup GC can match orphans with no risk of deleting real documents.
 */
const TEMP_INFIX = ".porthippotmp-";

/** Suffix appended after the unique counter. */
const TEMP_SUFFIX = ".tmp";

/** Matches a temp file name produced by {@link tempPathFor}. */
const TEMP_FILE_RE = /\.porthippotmp-\d+\.tmp$/;

/** Process-local monotonic counter keeping concurrent temp names unique. */
let tempCounter = 0;

/** Resolved absolute paths of temp files currently mid-write. */
const activeTempPaths = new Set();

/**
 * Build a unique temp path for an atomic write to `filePath`.
 * @param {string} filePath
 * @returns {string}
 */
function tempPathFor(filePath) {
  tempCounter += 1;
  return `${filePath}${TEMP_INFIX}${tempCounter}${TEMP_SUFFIX}`;
}

/**
 * @param {string} name A bare file name (not a full path).
 * @returns {boolean} True if `name` is one of our write temp files.
 */
function isTempFileName(name) {
  return TEMP_FILE_RE.test(name);
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Best-effort fsync of a directory so a rename into it survives a crash.
 *
 * Silently ignores platforms that disallow opening or fsyncing a directory
 * (notably Windows, where opening a directory throws EISDIR/EPERM). On POSIX
 * this is what makes a freshly-renamed file's *name* durable, not just its
 * contents.
 *
 * @param {string} dir
 */
function fsyncDir(dir) {
  let dirFd;
  try {
    dirFd = fs.openSync(dir, "r");
    fs.fsyncSync(dirFd);
  } catch {
    /* directory fsync unsupported / not permitted — best effort */
  } finally {
    if (dirFd !== undefined) {
      try {
        fs.closeSync(dirFd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Atomically and durably write `data` to `filePath` using a
 * write-temp → fsync → rename → fsync-dir strategy.
 *
 * The fsync of the temp file flushes its bytes before the rename, and the
 * directory fsync persists the rename itself — without these a crash or
 * power-loss shortly after the rename can leave a zero-length or truncated file
 * (the rename's metadata reaches disk while the data blocks do not).
 * `fs.writeFileSync` alone only guarantees the bytes reached the OS page cache,
 * not durable storage.
 *
 * @param {string} filePath
 * @param {string|Buffer} data
 */
function atomicWrite(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpPath = tempPathFor(filePath);
  const tmpKey = path.resolve(tmpPath);
  activeTempPaths.add(tmpKey);
  try {
    // Open an fd so the contents can be fsync'd before the rename;
    // writeFileSync(path, …) would close the fd internally with no flush.
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, data, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
    fsyncDir(path.dirname(filePath));
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    activeTempPaths.delete(tmpKey);
  }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────

/**
 * Write `obj` as pretty-printed JSON to `filePath`, atomically.
 *
 * Object documents are stamped with the current schema version before writing
 * (see migrations.js); arrays and non-objects are written unchanged.
 * @param {string} filePath
 * @param {*} obj
 */
function writeJSON(filePath, obj) {
  const json = JSON.stringify(migrate(obj), null, 2);
  if (typeof json !== "string") {
    throw new Error(`refusing to write non-serializable JSON to ${filePath}`);
  }
  atomicWrite(filePath, json);
}

/**
 * Move a corrupt/unparseable JSON file aside so a single damaged document can't
 * brick the whole load, while preserving its bytes for manual recovery.
 * Best-effort: if the rename itself fails (e.g. permissions), we still degrade to
 * "missing" rather than throw.
 *
 * @param {string} filePath The corrupt file.
 * @param {Error}  parseErr The JSON.parse failure, for the log line.
 */
function quarantineCorruptFile(filePath, parseErr) {
  // Timestamp + short random token so two corrupt reads of the same path within
  // the same millisecond can't clobber each other's quarantine copy.
  const dest = `${filePath}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(filePath, dest);
    console.warn(
      `[store] Corrupt JSON at ${filePath} (${parseErr.message}); quarantined to ${dest} and treating as empty.`,
    );
  } catch (renameErr) {
    console.warn(
      `[store] Corrupt JSON at ${filePath} (${parseErr.message}); could not quarantine (${renameErr.message}); treating as empty.`,
    );
  }
}

/**
 * Read and parse JSON from `filePath`.
 *
 * Object documents are run forward through any pending schema migrations and
 * stamped with the current schema version in memory (the upgraded form is
 * persisted lazily on the next save, not eagerly rewritten here).
 *
 * Returns `null` silently if the file does not exist. A file whose contents are
 * not valid JSON (truncated by a crash, hand-edited, disk corruption) is
 * quarantined aside (see {@link quarantineCorruptFile}) and likewise reported as
 * `null`, so one bad document degrades gracefully instead of failing the entire
 * load. Other read errors (EACCES, EISDIR) and migration failures still throw.
 * @param {string} filePath
 * @returns {*}
 */
function readJSON(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Parse failure ⇒ the file is corrupt. Quarantine + degrade to "missing".
    quarantineCorruptFile(filePath, err);
    return null;
  }
  return migrate(parsed);
}

// ── Filesystem helpers ──────────────────────────────────────────────────────────

/**
 * Best-effort recursive delete of a file or directory.
 *
 * Never throws: a missing path is a no-op (via `force`), and any other failure
 * is swallowed. Callers that must distinguish "did not exist" from "removed"
 * should not use this helper.
 *
 * @param {string} targetPath File or directory to remove.
 */
function remove(targetPath) {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } catch {
    /* best-effort: a failed cleanup is never fatal */
  }
}

/**
 * List a directory's entries, returning `[]` when it is missing or unreadable.
 *
 * `opts` is forwarded verbatim to fs.readdirSync, so `{ withFileTypes: true }`
 * yields Dirent objects exactly as the underlying call would.
 *
 * @param {string} dir
 * @param {object} [opts] Options forwarded to fs.readdirSync.
 * @returns {string[]|import('fs').Dirent[]}
 */
function listDir(dir, opts) {
  try {
    return fs.readdirSync(dir, opts);
  } catch {
    return []; // missing / unreadable dir — nothing to list
  }
}

/**
 * @param {string} targetPath
 * @returns {boolean} True if the path exists.
 */
function exists(targetPath) {
  return fs.existsSync(targetPath);
}

/**
 * Rename (move) `src` to `dest` on the same filesystem.
 *
 * Unlike {@link remove}, this propagates errors: callers that move data aside
 * for a rollback need to know whether the move actually happened. A missing
 * `src` throws ENOENT, so guard optional sources with {@link exists}.
 *
 * @param {string} src
 * @param {string} dest
 */
function move(src, dest) {
  fs.renameSync(src, dest);
}

// ── Orphan temp-file GC ─────────────────────────────────────────────────────────

/**
 * Recursively remove orphaned temp files left behind by a crashed write.
 *
 * A file is removed only if its name matches the temp-file pattern, it is older
 * than `maxAgeMs`, and it is not currently in-flight. Real data files never match
 * the pattern, so they are always left untouched. Best-effort: per-file errors
 * are swallowed and the scan continues.
 *
 * @param {string} dir Root directory to scan.
 * @param {object} [opts]
 * @param {number} [opts.maxAgeMs] Minimum age (ms) before an orphan is deleted. Default 5000.
 * @param {number} [opts.now] Reference timestamp (ms). Defaults to Date.now().
 * @returns {string[]} Absolute paths of the files that were removed.
 */
function gcOrphanTempFiles(dir, opts = {}) {
  const maxAgeMs = opts.maxAgeMs ?? 5000;
  const now = opts.now ?? Date.now();
  const removed = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed; // missing / unreadable dir — nothing to collect
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed.push(...gcOrphanTempFiles(full, { maxAgeMs, now }));
      continue;
    }
    if (!isTempFileName(entry.name)) continue;
    if (activeTempPaths.has(path.resolve(full))) continue;
    try {
      const stat = fs.statSync(full);
      if (now - stat.mtimeMs < maxAgeMs) continue; // too fresh — may be in flight
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      /* ignore — already gone or racing with a writer */
    }
  }
  return removed;
}

// ── ID validation ─────────────────────────────────────────────────────────────
//
// Tagged errors in this module advertise their kind on `.code` — the
// main-process error discriminator (see the note in main.js).

/**
 * Forbidden character pattern for storage IDs.
 * Disallows path separators, angle brackets, control characters, etc.
 */
const FORBIDDEN_ID_RE = /[/\\<>:"|?*\x00-\x1f]/;

/**
 * Whether `id` is safe to use as a filename component (non-empty string, not
 * "."/".."/free of path separators or other forbidden characters). The
 * non-throwing counterpart to validateID, for callers that ingest ids from
 * untrusted data and want to skip a bad ref rather than abort.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
function isValidID(id) {
  return (
    typeof id === "string" &&
    id !== "" &&
    id !== "." &&
    id !== ".." &&
    !FORBIDDEN_ID_RE.test(id)
  );
}

/**
 * Validate that `id` is safe to use as a filename component.
 * Throws an error (code "INVALID_ID") on failure.
 *
 * @param {string} id
 * @param {string} [label] - context label for error messages
 */
function validateID(id, label = "id") {
  if (!id || typeof id !== "string") {
    const err = new Error(`invalid ${label}: must be a non-empty string`);
    err.code = "INVALID_ID";
    throw err;
  }
  if (!isValidID(id)) {
    const err = new Error(`invalid ${label}: contains forbidden characters`);
    err.code = "INVALID_ID";
    throw err;
  }
}

// ── UUID ──────────────────────────────────────────────────────────────────────

/** @returns {string} A new UUIDv4 string. */
function newUUID() {
  return randomUUID();
}

// ── Not-found error factory ───────────────────────────────────────────────────

/**
 * Create a "not found" error for the given resource.
 * @param {string} message
 * @returns {Error}
 */
function notFoundError(message) {
  const err = new Error(message);
  err.code = "NOT_FOUND";
  return err;
}

module.exports = {
  ensureDir,
  atomicWrite,
  writeJSON,
  readJSON,
  remove,
  listDir,
  exists,
  move,
  gcOrphanTempFiles,
  isTempFileName,
  isValidID,
  validateID,
  newUUID,
  notFoundError,
};
