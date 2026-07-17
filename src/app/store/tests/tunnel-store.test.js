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

function makeCred(cs, over = {}) {
  return cs.create({
    label: "prod",
    user: "jason",
    authType: "password",
    password: "s3cr3t",
    ...over,
  });
}

function makeDef(credentialId, over = {}) {
  return {
    name: "prod db",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    sshHost: "db.internal",
    credentialId,
    ...over,
  };
}

test("create stamps id + defaults and returns a view with order + summary", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.tunnelStore().create(makeDef(cred.id));

    assert.ok(created.id, "assigned an id");
    assert.equal(created.order, 0);
    assert.equal(created.enabled, true); // default
    assert.deepEqual(created.jumpHostIds, []); // default
    assert.equal(created.credentialId, cred.id);
    assert.ok(
      created.routeSummary.includes("db.internal:5432"),
      "route summary built from the destination",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a schedule (Feature 150) round-trips and clears when a later update omits it", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const ts = stores.tunnelStore();
    const cred = makeCred(stores.credentialStore());
    const schedule = {
      time: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
      network: { ssids: ["Home"] },
    };

    const created = ts.create(makeDef(cred.id, { schedule }));
    assert.deepEqual(created.schedule, schedule);
    assert.deepEqual(ts.get(created.id).schedule, schedule); // persisted

    // A full-payload update that still carries the schedule keeps it.
    const kept = ts.update(created.id, makeDef(cred.id, { schedule }));
    assert.deepEqual(kept.schedule, schedule);

    // A full-payload update that OMITS it clears it (schedule is authoritative).
    const cleared = ts.update(created.id, makeDef(cred.id));
    assert.equal(cleared.schedule, undefined);
    assert.equal(ts.get(created.id).schedule, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tunnel record carries no secret; the credential holds the sealed one", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.tunnelStore().create(makeDef(cred.id));

    const raw = readRawTunnels(dir);
    assert.ok(!raw.includes("s3cr3t"), "no plaintext secret on disk");
    assert.ok(raw.includes("enck:v1:"), "sealed with the app-key backend");

    const view = stores.tunnelStore().get(created.id);
    assert.equal(view.password, undefined, "a tunnel has no secret field");
    assert.equal(view.credentialId, cred.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDecrypted resolves the target server + exit, decrypting the credential", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    // A simple tunnel: SSH into db.internal, forward to loopback on it (the Exit).
    const created = stores
      .tunnelStore()
      .create(
        makeDef(cred.id, { destination: { host: "127.0.0.1", port: 5432 } }),
      );

    const dec = stores.tunnelStore().getDecrypted(created.id);
    assert.equal(dec.sshServer.host, "db.internal");
    assert.equal(dec.sshServer.port, 22);
    assert.equal(dec.sshServer.user, "jason");
    assert.equal(dec.sshServer.auth[0].type, "password");
    assert.equal(dec.sshServer.auth[0].password, "s3cr3t"); // decrypted in-process
    assert.deepEqual(dec.destination, { host: "127.0.0.1", port: 5432 });
    assert.equal(dec.bindHost, "127.0.0.1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("getDecrypted resolves a bastion (sshHost set) forwarding to the dest host", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const t = stores
      .tunnelStore()
      .create(
        makeDef(cred.id, { sshHost: "bastion.example.com", sshPort: 2222 }),
      );

    const dec = stores.tunnelStore().getDecrypted(t.id);
    assert.equal(dec.sshServer.host, "bastion.example.com");
    assert.equal(dec.sshServer.port, 2222);
    assert.deepEqual(dec.destination, { host: "db.internal", port: 5432 });
    // The list summary flags the bastion.
    assert.ok(
      stores
        .tunnelStore()
        .get(t.id)
        .routeSummary.includes("via bastion.example.com"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jump hosts resolve into the chain in order, decrypted", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const jh = stores.jumpHostStore().create({
      label: "relay",
      host: "relay1",
      port: 22,
      credentialId: cred.id,
    });
    const t = stores
      .tunnelStore()
      .create(makeDef(cred.id, { jumpHostIds: [jh.id] }));

    const dec = stores.tunnelStore().getDecrypted(t.id);
    assert.equal(dec.jumps.length, 1);
    assert.equal(dec.jumps[0].host, "relay1");
    assert.equal(dec.jumps[0].auth[0].password, "s3cr3t");
    assert.ok(
      stores.tunnelStore().get(t.id).routeSummary.includes("jump: relay"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("definitions survive an app restart (new Stores over the same dir)", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.tunnelStore().create(makeDef(cred.id));

    const stores2 = new Stores(dir);
    const list = stores2.tunnelStore().list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, created.id);
    assert.equal(
      stores2.tunnelStore().getDecrypted(created.id).sshServer.auth[0].password,
      "s3cr3t",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an update that changes only the name keeps its references", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.tunnelStore().create(makeDef(cred.id));

    const updated = stores
      .tunnelStore()
      .update(created.id, { name: "renamed" });
    assert.equal(updated.name, "renamed");
    assert.equal(updated.credentialId, cred.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an update can clear an optional field (SSH port / LAN bind / linger) by omitting it", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    const created = stores.tunnelStore().create(
      makeDef(cred.id, {
        sshHost: "bastion.example.com",
        sshPort: 2222,
        bindHost: "0.0.0.0",
        lingerMs: 60000,
      }),
    );
    assert.equal(created.sshPort, 2222);

    // The editor omits blanked optionals from its payload; the update must not
    // resurrect the stored values through the shallow merge. The target server
    // (sshHost) is mandatory, so it is always sent and retained.
    const updated = stores.tunnelStore().update(created.id, {
      name: created.name,
      localPort: created.localPort,
      destination: created.destination,
      sshHost: created.sshHost,
      credentialId: created.credentialId,
      jumpHostIds: [],
      keepAlive: false,
      enabled: true,
      autoReconnect: false,
    });

    assert.equal(
      updated.sshHost,
      "bastion.example.com",
      "target server retained",
    );
    assert.equal(updated.sshPort, undefined, "SSH port override cleared");
    assert.equal(updated.bindHost, undefined, "LAN bind cleared");
    assert.equal(updated.lingerMs, undefined, "linger override cleared");

    // ...and it survives a reload from disk.
    const reloaded = new Stores(dir).tunnelStore().get(created.id);
    assert.equal(reloaded.sshPort, undefined);
    assert.equal(reloaded.bindHost, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("list is ordered, reorder rewrites order, delete reindexes", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const ts = stores.tunnelStore();
    const cred = makeCred(stores.credentialStore());
    const a = ts.create(makeDef(cred.id, { name: "a" }));
    const b = ts.create(makeDef(cred.id, { name: "b" }));
    const c = ts.create(makeDef(cred.id, { name: "c" }));

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
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());
    assert.throws(
      () => stores.tunnelStore().create(makeDef(cred.id, { localPort: 99999 })),
      (err) =>
        err.code === "INVALID_DEFINITION" && Boolean(err.errors.localPort),
    );
    assert.equal(stores.tunnelStore().list().length, 0, "nothing was written");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects a dangling credential / jump-host reference", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = makeCred(stores.credentialStore());

    assert.throws(
      () => stores.tunnelStore().create(makeDef("no-such-cred")),
      (err) =>
        err.code === "INVALID_DEFINITION" && Boolean(err.errors.credentialId),
    );
    assert.throws(
      () =>
        stores
          .tunnelStore()
          .create(makeDef(cred.id, { jumpHostIds: ["no-such-jump"] })),
      (err) =>
        err.code === "INVALID_DEFINITION" &&
        Boolean(err.errors["jumpHostIds[0]"]),
    );
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
