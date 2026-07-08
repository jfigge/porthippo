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

const { Paths } = require("../paths");
const { KnownHostsStore } = require("../known-hosts-store");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-hosts-"));
  return { dir, store: new KnownHostsStore(new Paths(dir)) };
}

test("trust records a fingerprint that get / list read back", () => {
  const { dir, store } = freshStore();
  try {
    assert.equal(store.get("bastion:22"), null);
    const entry = store.trust("bastion:22", "SHA256:abc");
    assert.equal(entry.hostPort, "bastion:22");
    assert.equal(entry.fingerprint, "SHA256:abc");
    assert.equal(typeof entry.addedAt, "number");

    assert.equal(store.get("bastion:22").fingerprint, "SHA256:abc");
    assert.deepEqual(
      store.list().map((e) => e.hostPort),
      ["bastion:22"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("trust persists across a fresh store instance", () => {
  const { dir } = freshStore();
  try {
    new KnownHostsStore(new Paths(dir)).trust("h:22", "fp");
    assert.equal(
      new KnownHostsStore(new Paths(dir)).get("h:22").fingerprint,
      "fp",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoke removes an entry and is idempotent", () => {
  const { dir, store } = freshStore();
  try {
    store.trust("h:22", "fp");
    assert.deepEqual(store.revoke("h:22"), { hostPort: "h:22", revoked: true });
    assert.equal(store.get("h:22"), null);
    assert.deepEqual(store.revoke("h:22"), {
      hostPort: "h:22",
      revoked: false,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("bad arguments are rejected", () => {
  const { dir, store } = freshStore();
  try {
    assert.throws(
      () => store.get(""),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.trust("h:22", ""),
      (e) => e.code === "INVALID_ARG",
    );
    assert.throws(
      () => store.revoke(null),
      (e) => e.code === "INVALID_ARG",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
