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
  return fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-creds-"));
}
function readRaw(dir) {
  return fs.readFileSync(path.join(dir, "tunnels.json"), "utf8");
}

test("create seals the secret; reads expose only hasSecret", () => {
  const dir = freshDir();
  try {
    const cs = new Stores(dir).credentialStore();
    const created = cs.create({
      label: "prod",
      user: "jason",
      authType: "password",
      password: "s3cr3t",
    });

    assert.ok(created.id);
    assert.equal(created.hasSecret, true);
    assert.equal(created.password, undefined, "plaintext never crosses IPC");

    const raw = readRaw(dir);
    assert.ok(!raw.includes("s3cr3t"), "no plaintext secret on disk");
    assert.ok(raw.includes("enck:v1:"), "sealed with the app-key backend");

    assert.equal(cs.get(created.id).hasSecret, true);
    assert.equal(cs.getDecrypted(created.id).password, "s3cr3t");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a key passphrase seals and round-trips; the key path is not secret", () => {
  const dir = freshDir();
  try {
    const cs = new Stores(dir).credentialStore();
    const created = cs.create({
      label: "key",
      user: "u",
      authType: "key",
      keyPath: "/home/u/.ssh/id",
      passphrase: "phr@se",
    });

    const raw = readRaw(dir);
    assert.ok(!raw.includes("phr@se"), "no plaintext passphrase on disk");
    assert.ok(raw.includes("/home/u/.ssh/id"), "the key PATH is not a secret");
    assert.equal(created.hasSecret, true);
    assert.equal(cs.getDecrypted(created.id).passphrase, "phr@se");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update: keep (hasSecret) retains, re-enter replaces, omit clears", () => {
  const dir = freshDir();
  try {
    const cs = new Stores(dir).credentialStore();
    const created = cs.create({
      label: "L",
      user: "u",
      authType: "password",
      password: "orig",
    });

    // Keep the existing secret (hasSecret:true, no value) while editing the user.
    cs.update(created.id, {
      user: "u2",
      authType: "password",
      hasSecret: true,
    });
    assert.equal(cs.getDecrypted(created.id).password, "orig");
    assert.equal(cs.get(created.id).user, "u2");

    // Re-enter a new secret.
    cs.update(created.id, { authType: "password", password: "rotated" });
    assert.equal(cs.getDecrypted(created.id).password, "rotated");

    // Clear it (no hasSecret, no value).
    cs.update(created.id, { authType: "password" });
    assert.equal(cs.get(created.id).hasSecret, false);
    assert.equal(cs.getDecrypted(created.id).password, undefined);
    assert.ok(!readRaw(dir).includes("rotated"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("switching authType drops the stray secret + key path", () => {
  const dir = freshDir();
  try {
    const cs = new Stores(dir).credentialStore();
    const created = cs.create({
      label: "L",
      user: "u",
      authType: "password",
      password: "pw",
    });
    // Switch to agent — the password must not linger (agent carries no secret,
    // so hasSecret is absent rather than a literal false).
    cs.update(created.id, { authType: "agent" });
    const decrypted = cs.getDecrypted(created.id);
    assert.equal(decrypted.password, undefined);
    assert.ok(!cs.get(created.id).hasSecret);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete is blocked while a tunnel or jump host references it", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cs = stores.credentialStore();

    // Referenced by a tunnel.
    const cred = cs.create({ label: "L", user: "u", authType: "agent" });
    stores.tunnelStore().create({
      name: "t",
      localPort: 1234,
      destination: { host: "h", port: 80 },
      credentialId: cred.id,
    });
    assert.throws(
      () => cs.delete(cred.id),
      (e) => e.code === "IN_USE" && e.references.length === 1,
    );

    // Referenced by a jump host.
    const cred2 = cs.create({ label: "J", user: "u", authType: "agent" });
    stores.jumpHostStore().create({
      label: "relay",
      host: "relay1",
      port: 22,
      credentialId: cred2.id,
    });
    assert.throws(
      () => cs.delete(cred2.id),
      (e) => e.code === "IN_USE",
    );

    // An unreferenced credential deletes cleanly.
    const cred3 = cs.create({ label: "free", user: "u", authType: "agent" });
    assert.deepEqual(cs.delete(cred3.id), { id: cred3.id });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects an invalid credential; update of unknown id is NOT_FOUND", () => {
  const dir = freshDir();
  try {
    const cs = new Stores(dir).credentialStore();
    assert.throws(
      () => cs.create({ label: "", user: "u", authType: "agent" }),
      (e) => e.code === "INVALID_CREDENTIAL" && Boolean(e.errors.label),
    );
    assert.throws(
      () => cs.update("nope", { label: "x" }),
      (e) => e.code === "NOT_FOUND",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
