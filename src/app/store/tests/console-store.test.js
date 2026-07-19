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
  return fs.mkdtempSync(path.join(os.tmpdir(), "jumphippo-consoles-"));
}

function makeCred(cs, over = {}) {
  return cs.create({
    label: "prod",
    user: "jason",
    authType: "password",
    password: "s3cr3t",
    ...over,
  });
}

function makeJump(js, credentialId, over = {}) {
  return js.create({
    label: "bastion",
    host: "bastion.example.com",
    port: 22,
    credentialId,
    ...over,
  });
}

function makeConsole(credentialId, over = {}) {
  return { name: "db shell", sshHost: "db.internal", credentialId, ...over };
}

test("create stamps id + defaults and returns a view with order + summary", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.consoleStore().create(makeConsole(cred.id));

    assert.ok(created.id, "assigned an id");
    assert.equal(created.order, 0);
    assert.deepEqual(created.jumpHostIds, []); // default
    assert.equal(created.credentialId, cred.id);
    assert.ok(
      created.routeSummary.includes("db.internal:22"),
      "route summary defaults the port to 22",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a bad definition and a dangling reference", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());

    // Structural failure (no name / no sshHost).
    assert.throws(
      () => stores.consoleStore().create({ credentialId: cred.id }),
      (err) => err.code === "INVALID_DEFINITION" && !!err.errors.name,
    );

    // Referential failure (unknown credential).
    assert.throws(
      () => stores.consoleStore().create(makeConsole("nope")),
      (err) => err.code === "INVALID_DEFINITION" && !!err.errors.credentialId,
    );

    // Referential failure (unknown jump host).
    assert.throws(
      () =>
        stores
          .consoleStore()
          .create(makeConsole(cred.id, { jumpHostIds: ["ghost"] })),
      (err) =>
        err.code === "INVALID_DEFINITION" && !!err.errors["jumpHostIds[0]"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update patches fields and clears an omitted optional sshPort", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cs = stores.consoleStore();
    const cred = makeCred(stores.credentialStore());
    const created = cs.create(makeConsole(cred.id, { sshPort: 2222 }));
    assert.equal(created.sshPort, 2222);

    // A later payload without sshPort clears it (back to the default 22).
    const updated = cs.update(
      created.id,
      makeConsole(cred.id, { name: "renamed" }),
    );
    assert.equal(updated.name, "renamed");
    assert.equal(
      updated.sshPort,
      undefined,
      "omitted optional field is cleared",
    );
    assert.ok(updated.routeSummary.includes("db.internal:22"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDecrypted resolves the hop chain with the credential decrypted", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const jump = makeJump(stores.jumpHostStore(), cred.id);
    const created = stores
      .consoleStore()
      .create(makeConsole(cred.id, { sshPort: 2200, jumpHostIds: [jump.id] }));

    const resolved = stores.consoleStore().getDecrypted(created.id);
    assert.equal(resolved.sshServer.host, "db.internal");
    assert.equal(resolved.sshServer.port, 2200);
    assert.equal(resolved.sshServer.user, "jason");
    assert.equal(resolved.sshServer.auth[0].type, "password");
    assert.equal(resolved.sshServer.auth[0].password, "s3cr3t");
    assert.equal(resolved.jumps.length, 1);
    assert.equal(resolved.jumps[0].host, "bastion.example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reorder rewrites display order and appends any omitted console", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cs = stores.consoleStore();
    const cred = makeCred(stores.credentialStore());
    const a = cs.create(makeConsole(cred.id, { name: "a" }));
    cs.create(makeConsole(cred.id, { name: "b" })); // omitted from reorder → appended
    const c = cs.create(makeConsole(cred.id, { name: "c" }));

    const out = cs.reorder([c.id, a.id]); // b omitted → appended after
    assert.deepEqual(
      out.map((x) => x.name),
      ["c", "a", "b"],
    );
    assert.deepEqual(
      out.map((x) => x.order),
      [0, 1, 2],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a credential / jump host used by a console cannot be deleted", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const jump = makeJump(stores.jumpHostStore(), cred.id);
    stores
      .consoleStore()
      .create(makeConsole(cred.id, { jumpHostIds: [jump.id] }));

    assert.throws(
      () => stores.jumpHostStore().delete(jump.id),
      (err) =>
        err.code === "IN_USE" &&
        err.references.some((r) => r.type === "console"),
    );
    // The credential is referenced by both the console and the jump host.
    assert.throws(
      () => stores.credentialStore().delete(cred.id),
      (err) =>
        err.code === "IN_USE" &&
        err.references.some((r) => r.type === "console"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
