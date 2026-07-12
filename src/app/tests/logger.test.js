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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createLogger, formatArg } = require("../logger");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-log-"));
}

test("a line carries an ISO timestamp, level and scope, parts space-joined", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir });
    log.info("startup", "hello", "world");
    const content = fs.readFileSync(log.currentPath, "utf8");
    assert.match(
      content,
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[info\] \[startup\] hello world\n$/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("levels below the minimum are dropped", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir, level: "info" });
    log.debug("scope", "should not appear");
    log.warn("scope", "should appear");
    const content = fs.readFileSync(log.currentPath, "utf8");
    assert.ok(!content.includes("should not appear"));
    assert.ok(content.includes("should appear"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an Error argument expands to name: message plus a stack", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir });
    log.error("boom", new Error("kaboom"));
    const content = fs.readFileSync(log.currentPath, "utf8");
    assert.ok(content.includes("Error: kaboom"));
    assert.ok(content.includes("at ")); // a stack frame
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("formatArg JSON-encodes objects and tolerates cycles", () => {
  assert.equal(formatArg({ a: 1 }), '{"a":1}');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(typeof formatArg(cyclic), "string"); // does not throw
  assert.equal(formatArg(undefined), "undefined");
});

test("rotation caps the number of files at maxFiles", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir, maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 50; i++) log.info("bulk", `line number ${i} padding`);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("main"))
      .sort();
    assert.ok(files.length <= 3, `expected ≤3 files, got ${files}`);
    assert.ok(files.includes("main.log")); // current file present
    // The newest line lives in the current (un-suffixed) file.
    assert.ok(fs.readFileSync(log.currentPath, "utf8").includes("line number"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("listFiles is newest-first and readFiles is oldest-first", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir, maxBytes: 120, maxFiles: 4 });
    for (let i = 0; i < 20; i++) log.info("s", `padding line ${i} xxxxxxxx`);
    const list = log.listFiles().map((p) => path.basename(p));
    assert.equal(list[0], "main.log"); // newest first
    const read = log.readFiles().map((f) => f.name);
    assert.equal(read[read.length - 1], "main.log"); // oldest first ⇒ current last
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readTail caps total bytes yet keeps the most recent activity", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir, maxBytes: 400, maxFiles: 5 });
    for (let i = 0; i < 200; i++) {
      log.info("bulk", `line number ${i} padding padding`);
    }
    const lastLine = "FINAL-MARKER-LINE";
    log.info("bulk", lastLine);

    const tail = log.readTail(500);
    const total = tail.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    const full = log
      .readFiles()
      .reduce((n, f) => n + Buffer.byteLength(f.content), 0);

    // Bounded near the budget (a truncation marker adds a little slack)…
    assert.ok(total <= 600, `expected tail ≤ ~budget, got ${total}`);
    // …and strictly smaller than the full log, proving we actually capped it.
    assert.ok(full > total, `full ${full} should exceed tail ${total}`);
    // The tail still ends at "now": the newest line survives.
    assert.ok(
      tail
        .map((f) => f.content)
        .join("")
        .includes(lastLine),
      "tail keeps the newest line",
    );
    // The oldest included file is front-truncated with a marker.
    assert.ok(
      tail.some((f) => f.content.startsWith("…(truncated)…")),
      "oldest included file is front-truncated",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("install tees console into the file and still calls the original", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir });
    const seen = [];
    const realLog = console.log;
    console.log = (...a) => seen.push(a.join(" "));
    log.install();
    console.log("teed message");
    log.uninstall();
    // Original still received it…
    assert.ok(seen.some((s) => s.includes("teed message")));
    console.log = realLog;
    // …and it landed in the file.
    assert.ok(
      fs.readFileSync(log.currentPath, "utf8").includes("teed message"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall restores the original console identity", () => {
  const dir = freshDir();
  try {
    const log = createLogger({ dir });
    const before = console.error;
    log.install();
    assert.notEqual(console.error, before);
    log.uninstall();
    assert.equal(console.error, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a write to an unwritable directory does not throw", () => {
  const dir = freshDir();
  try {
    // Use a regular file as if it were a directory — mkdir/append will fail,
    // but the logger swallows it rather than crashing the app.
    const asFile = path.join(dir, "not-a-dir");
    fs.writeFileSync(asFile, "x");
    const log = createLogger({ dir: path.join(asFile, "logs") });
    assert.doesNotThrow(() => log.error("scope", "message"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
