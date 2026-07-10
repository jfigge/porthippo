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

const { Stores } = require("../stores");

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-jumps-"));
}

function seedCredential(stores) {
  return stores.credentialStore().create({
    label: "L",
    user: "u",
    authType: "agent",
  });
}

test("create defaults the SSH port and returns the record", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);
    const jh = stores.jumpHostStore().create({
      label: "relay",
      host: "relay1",
      credentialId: cred.id,
    });
    assert.ok(jh.id);
    assert.equal(jh.port, 22, "port defaults to 22 when omitted");
    assert.equal(stores.jumpHostStore().list().length, 1);
    assert.equal(stores.jumpHostStore().get(jh.id).host, "relay1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a dangling credentialId and an invalid record", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);

    assert.throws(
      () =>
        stores.jumpHostStore().create({
          label: "relay",
          host: "relay1",
          port: 22,
          credentialId: "no-such-cred",
        }),
      (e) => e.code === "INVALID_JUMP_HOST" && Boolean(e.errors.credentialId),
    );

    assert.throws(
      () =>
        stores.jumpHostStore().create({
          label: "relay",
          host: "",
          port: 22,
          credentialId: cred.id,
        }),
      (e) => e.code === "INVALID_JUMP_HOST" && Boolean(e.errors.host),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete is blocked while a tunnel lists it in jumpHostIds", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);
    const jh = stores.jumpHostStore().create({
      label: "relay",
      host: "relay1",
      port: 22,
      credentialId: cred.id,
    });
    stores.tunnelStore().create({
      name: "t",
      localPort: 1234,
      destination: { host: "h", port: 80 },
      credentialId: cred.id,
      jumpHostIds: [jh.id],
    });

    assert.throws(
      () => stores.jumpHostStore().delete(jh.id),
      (e) => e.code === "IN_USE" && e.references.length === 1,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update / delete of an unknown id throw NOT_FOUND", () => {
  const dir = freshDir();
  try {
    const jhs = new Stores(dir).jumpHostStore();
    assert.throws(
      () => jhs.update("nope", { label: "x" }),
      (e) => e.code === "NOT_FOUND",
    );
    assert.throws(
      () => jhs.delete("nope"),
      (e) => e.code === "NOT_FOUND",
    );
    assert.equal(jhs.get("nope"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
