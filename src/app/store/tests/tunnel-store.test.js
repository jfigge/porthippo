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

// Each test gets an isolated data dir; constructing Stores bootstraps app-key
// secret storage (safeStorage is absent in a plain `node --test` process) and
// configures crypto, so secrets are really sealed on disk.
function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-tunnels-"));
}

function readRawTunnels(dir) {
  return fs.readFileSync(path.join(dir, "tunnels.json"), "utf8");
}

function makeDef(over = {}) {
  return {
    name: "prod db",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    sshServer: {
      host: "bastion.example.com",
      port: 22,
      user: "jason",
      auth: [{ type: "password", password: "s3cr3t" }],
    },
    jumps: [],
    ...over,
  };
}

test("create stamps id + defaults and returns a secret-free view", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(makeDef());

    assert.ok(created.id, "assigned an id");
    assert.equal(created.order, 0);
    assert.equal(created.enabled, true); // default
    assert.equal(created.bindHost, "127.0.0.1"); // default loopback
    assert.equal(created.keepAlive, false); // default

    const authEntry = created.sshServer.auth[0];
    assert.equal(authEntry.hasSecret, true, "renderer sees hasSecret");
    assert.equal(authEntry.password, undefined, "plaintext never crosses IPC");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a password is stored encrypted and only decrypts in-process", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(makeDef());

    // On disk: ciphertext, never the plaintext.
    const raw = readRawTunnels(dir);
    assert.ok(!raw.includes("s3cr3t"), "no plaintext secret on disk");
    assert.ok(raw.includes("enck:v1:"), "sealed with the app-key backend");
    assert.ok(raw.includes('"enc"'), "stored under the { enc } shape");

    // Renderer read: hasSecret, no value.
    assert.equal(ts.get(created.id).sshServer.auth[0].hasSecret, true);
    assert.equal(ts.get(created.id).sshServer.auth[0].password, undefined);

    // Engine read (in-process): decrypted plaintext.
    const decrypted = ts.getDecrypted(created.id);
    assert.equal(decrypted.sshServer.auth[0].password, "s3cr3t");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("definitions survive an app restart (new Stores over the same dir)", () => {
  const dir = freshDir();
  try {
    const created = new Stores(dir).tunnelStore().create(makeDef());

    // Simulate a restart: a brand-new factory re-reads the same app key file.
    const ts2 = new Stores(dir).tunnelStore();
    const list = ts2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(
      ts2.getDecrypted(created.id).sshServer.auth[0].password,
      "s3cr3t",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a key passphrase is sealed and round-trips just like a password", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(
      makeDef({
        sshServer: {
          host: "h",
          port: 22,
          user: "u",
          auth: [
            {
              type: "key",
              privateKeyPath: "/home/u/.ssh/id",
              passphrase: "phr@se",
            },
          ],
        },
      }),
    );

    const raw = readRawTunnels(dir);
    assert.ok(!raw.includes("phr@se"), "no plaintext passphrase on disk");
    assert.ok(raw.includes("/home/u/.ssh/id"), "the key PATH is not a secret");
    assert.equal(created.sshServer.auth[0].hasSecret, true);
    assert.equal(created.sshServer.auth[0].passphrase, undefined);
    assert.equal(
      ts.getDecrypted(created.id).sshServer.auth[0].passphrase,
      "phr@se",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an update that never touches the secret keeps it (no clobber)", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(makeDef());

    const updated = ts.update(created.id, { name: "renamed" });
    assert.equal(updated.name, "renamed");
    assert.equal(updated.sshServer.auth[0].hasSecret, true);
    assert.equal(
      ts.getDecrypted(created.id).sshServer.auth[0].password,
      "s3cr3t",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("hasSecret:true with no value retains the on-disk ciphertext", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(makeDef());

    // Renderer sends the auth entry back exactly as it received it.
    ts.update(created.id, {
      sshServer: {
        host: "bastion.example.com",
        port: 2222, // an unrelated edit
        user: "jason",
        auth: [{ type: "password", hasSecret: true }],
      },
    });

    assert.equal(ts.get(created.id).sshServer.port, 2222);
    assert.equal(
      ts.getDecrypted(created.id).sshServer.auth[0].password,
      "s3cr3t",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-entering a secret replaces it; omitting hasSecret clears it", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const created = ts.create(makeDef());

    // Re-enter a new password.
    ts.update(created.id, {
      sshServer: {
        host: "h",
        port: 22,
        user: "jason",
        auth: [{ type: "password", password: "rotated" }],
      },
    });
    assert.equal(
      ts.getDecrypted(created.id).sshServer.auth[0].password,
      "rotated",
    );

    // Clear it (no hasSecret, no value).
    ts.update(created.id, {
      sshServer: {
        host: "h",
        port: 22,
        user: "jason",
        auth: [{ type: "password" }],
      },
    });
    assert.equal(ts.get(created.id).sshServer.auth[0].hasSecret, false);
    assert.equal(
      ts.getDecrypted(created.id).sshServer.auth[0].password,
      undefined,
    );
    assert.ok(!readRawTunnels(dir).includes("rotated"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list is ordered, reorder rewrites order, delete reindexes", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    const a = ts.create(makeDef({ name: "a" }));
    const b = ts.create(makeDef({ name: "b" }));
    const c = ts.create(makeDef({ name: "c" }));

    assert.deepEqual(
      ts.list().map((t) => t.name),
      ["a", "b", "c"],
    );
    assert.deepEqual(
      ts.list().map((t) => t.order),
      [0, 1, 2],
    );

    ts.reorder([c.id, a.id, b.id]);
    assert.deepEqual(
      ts.list().map((t) => t.name),
      ["c", "a", "b"],
    );

    // An id missing from the reorder list is appended, never dropped.
    ts.reorder([b.id]);
    assert.equal(ts.list().length, 3);
    assert.equal(ts.list()[0].name, "b");

    ts.delete(a.id);
    const names = ts.list().map((t) => t.name);
    assert.ok(!names.includes("a"));
    assert.deepEqual(
      ts.list().map((t) => t.order),
      [0, 1],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects an invalid definition with field-keyed errors", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    assert.throws(
      () => ts.create(makeDef({ localPort: 99999 })),
      (err) =>
        err.code === "INVALID_DEFINITION" && Boolean(err.errors.localPort),
    );
    assert.equal(ts.list().length, 0, "nothing was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update / delete of an unknown id throw NOT_FOUND", () => {
  const dir = freshDir();
  try {
    const ts = new Stores(dir).tunnelStore();
    assert.throws(
      () => ts.update("nope", { name: "x" }),
      (e) => e.code === "NOT_FOUND",
    );
    assert.throws(
      () => ts.delete("nope"),
      (e) => e.code === "NOT_FOUND",
    );
    assert.equal(ts.get("nope"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
