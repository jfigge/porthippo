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
 * logger.js — a tiny, dependency-free rotating file logger with a console tee
 * (ported from Rest Hippo). `createLogger({ dir })` returns a logger that writes
 * timestamped lines to `dir/main.log`, rotating to `main.1.log … main.<n>.log`
 * once the current file passes `maxBytes`. `install()` tees `console.*` into the
 * file (keeping the original console output), so all of main's existing
 * `console.error(...)` diagnostics are captured for the Feature 60 "copy
 * diagnostics" report without touching a single call site.
 *
 * Security: this only persists what `console.*` already prints, plus an Error's
 * name/message/stack. It must NEVER be handed raw secrets — passwords,
 * passphrases and private-key material are redacted at their call sites and
 * never logged. The diagnostics builder additionally scrubs the log tail as a
 * defense-in-depth pass (see diagnostics.js).
 *
 * Writes are synchronous (`appendFileSync`, O_APPEND — atomic per line on POSIX)
 * and can never throw: a filesystem failure is reported through the *original*
 * console (captured before install) so logging can't recurse or crash the app.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

// Which log level each console method maps to when teed.
const CONSOLE_LEVEL = Object.freeze({
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
});

const DEFAULTS = Object.freeze({
  fileName: "main.log",
  maxBytes: 1024 * 1024, // 1 MB per file before rotation
  maxFiles: 5, // main.log + main.1.log … main.4.log
  level: "info",
});

/**
 * Render one log argument to a string. Errors expand to `name: message` plus
 * their stack; objects are JSON-encoded (cycle-safe); everything else is
 * `String()`-ified.
 * @param {*} arg
 * @returns {string}
 */
function formatArg(arg) {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  }
  if (typeof arg === "string") return arg;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/**
 * Build a logger rooted at `opts.dir`.
 * @param {object} opts
 * @param {string} opts.dir       directory to hold the log files
 * @param {string} [opts.fileName="main.log"]
 * @param {number} [opts.maxBytes=1048576]
 * @param {number} [opts.maxFiles=5]
 * @param {string} [opts.level="info"]  minimum level to write
 * @returns {object} the logger API
 */
function createLogger(opts = {}) {
  const dir = opts.dir;
  const fileName = opts.fileName || DEFAULTS.fileName;
  const maxBytes = opts.maxBytes || DEFAULTS.maxBytes;
  const maxFiles = opts.maxFiles || DEFAULTS.maxFiles;
  const minLevel = LEVELS[opts.level] || LEVELS[DEFAULTS.level];

  const currentPath = path.join(dir, fileName);

  // Capture the real console up front so a write failure can be reported without
  // recursing through the patched methods that install() puts in place.
  const origConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: (console.debug || console.log).bind(console),
  };
  let patched = null; // saved originals while install() is active

  // The name of the nth rotated file (n >= 1): main.1.log, main.2.log, …
  const rotatedPath = (n) => {
    const ext = path.extname(fileName);
    const stem = ext ? fileName.slice(0, -ext.length) : fileName;
    return path.join(dir, `${stem}.${n}${ext}`);
  };

  function rotate() {
    // Drop the oldest, shift each down by one, then move current → .1.
    try {
      fs.rmSync(rotatedPath(maxFiles - 1), { force: true });
    } catch {
      /* best-effort */
    }
    for (let n = maxFiles - 2; n >= 1; n--) {
      try {
        fs.renameSync(rotatedPath(n), rotatedPath(n + 1));
      } catch {
        /* the file may not exist yet — ignore */
      }
    }
    try {
      fs.renameSync(currentPath, rotatedPath(1));
    } catch {
      /* nothing to rotate yet — ignore */
    }
  }

  function write(level, scope, parts) {
    if (LEVELS[level] < minLevel) return;
    const message = parts.map(formatArg).join(" ");
    const line = `${new Date().toISOString()} [${level}]${
      scope ? ` [${scope}]` : ""
    } ${message}\n`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(currentPath).size;
      } catch {
        size = 0;
      }
      // Rotate before writing when a non-empty file would exceed the cap. A
      // single over-cap line still lands (in a fresh file) rather than be lost.
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotate();
      fs.appendFileSync(currentPath, line);
    } catch (err) {
      // Never let logging crash the app; surface via the untouched console.
      origConsole.error("[logger] write failed:", err && err.message);
    }
  }

  const api = {
    debug: (scope, ...parts) => write("debug", scope, parts),
    info: (scope, ...parts) => write("info", scope, parts),
    warn: (scope, ...parts) => write("warn", scope, parts),
    error: (scope, ...parts) => write("error", scope, parts),

    /** The directory holding the log files. */
    dir,
    /** Absolute path of the current (newest) log file. */
    currentPath,

    /**
     * Tee `console.*` into the log file. Idempotent. The original console still
     * receives every call (so DevTools / the terminal are unaffected). We save
     * the ACTUAL current console methods so `uninstall()` restores them by
     * identity (not a bound copy).
     */
    install() {
      if (patched) return api;
      patched = {};
      for (const name of Object.keys(CONSOLE_LEVEL)) {
        patched[name] = console[name];
        const original = console[name] || console.log;
        console[name] = (...args) => {
          try {
            original(...args);
          } finally {
            write(CONSOLE_LEVEL[name], "console", args);
          }
        };
      }
      return api;
    },

    /** Restore the original console methods. */
    uninstall() {
      if (!patched) return api;
      for (const name of Object.keys(CONSOLE_LEVEL)) {
        if (patched[name]) console[name] = patched[name];
      }
      patched = null;
      return api;
    },

    /** Existing log files, newest-first: [main.log, main.1.log, …]. */
    listFiles() {
      const files = [];
      try {
        if (fs.statSync(currentPath).size >= 0) files.push(currentPath);
      } catch {
        /* no current file yet */
      }
      for (let n = 1; n < maxFiles; n++) {
        const p = rotatedPath(n);
        try {
          fs.accessSync(p);
          files.push(p);
        } catch {
          /* gap — stop looking further back */
        }
      }
      return files;
    },

    /**
     * The log files as `{ name, content }`, OLDEST-first — the order the
     * diagnostics report renders them so a reader scans forward in time.
     */
    readFiles() {
      return this.listFiles()
        .slice()
        .reverse()
        .map((p) => {
          let content = "";
          try {
            content = fs.readFileSync(p, "utf8");
          } catch {
            content = "";
          }
          return { name: path.basename(p), content };
        });
    },

    /**
     * The TAIL of the rotating log as `{ name, content }`, OLDEST-first, capped at
     * `maxBytes` total. The diagnostics report uses this so it never puts the full
     * (up to 5 × 1 MB) log on the clipboard: we walk newest→oldest keeping whole
     * files until the budget runs out, then truncate the front of the oldest
     * included file (a `…(truncated)…` marker) so the report still ends at "now".
     * @param {number} [maxBytes=65536]
     */
    readTail(maxBytes = 64 * 1024) {
      const picked = [];
      let budget = maxBytes;
      for (const p of this.listFiles()) {
        // listFiles() is newest-first.
        if (budget <= 0) break;
        let content = "";
        try {
          content = fs.readFileSync(p, "utf8");
        } catch {
          content = "";
        }
        if (Buffer.byteLength(content) > budget) {
          content = content.slice(-budget); // keep the most recent bytes
          const nl = content.indexOf("\n");
          if (nl >= 0) content = content.slice(nl + 1); // drop a partial first line
          content = `…(truncated)…\n${content}`;
          budget = 0;
        } else {
          budget -= Buffer.byteLength(content);
        }
        picked.push({ name: path.basename(p), content });
      }
      return picked.reverse(); // oldest-first, to match the report's render order
    },
  };

  return api;
}

module.exports = { createLogger, formatArg };
