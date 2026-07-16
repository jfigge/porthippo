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
  return fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-groups-"));
}

function seedCredential(stores) {
  return stores.credentialStore().create({
    label: "L",
    user: "u",
    authType: "agent",
  });
}

function seedTunnel(stores, credId, extra = {}) {
  return stores.tunnelStore().create({
    name: "t",
    localPort: 1234,
    destination: { host: "h", port: 80 },
    sshHost: "h",
    credentialId: credId,
    ...extra,
  });
}

test("create defaults the colour and returns the record with a derived order", () => {
  const dir = freshDir();
  try {
    const groups = new Stores(dir).groupStore();
    const g = groups.create({ label: "Work" });
    assert.ok(g.id);
    assert.equal(g.color, "blue", "colour defaults to the first palette token");
    assert.equal(g.order, 0, "order derived from array position");
    assert.equal(groups.list().length, 1);
    assert.equal(groups.get(g.id).label, "Work");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects an empty label and an off-palette colour", () => {
  const dir = freshDir();
  try {
    const groups = new Stores(dir).groupStore();
    assert.throws(
      () => groups.create({ label: "", color: "blue" }),
      (e) => e.code === "INVALID_GROUP" && Boolean(e.errors.label),
    );
    assert.throws(
      () => groups.create({ label: "Home", color: "#ff0000" }),
      (e) => e.code === "INVALID_GROUP" && Boolean(e.errors.color),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update patches label/colour; unknown id throws NOT_FOUND", () => {
  const dir = freshDir();
  try {
    const groups = new Stores(dir).groupStore();
    const g = groups.create({ label: "Work", color: "blue" });
    const updated = groups.update(g.id, { label: "Office", color: "green" });
    assert.equal(updated.label, "Office");
    assert.equal(updated.color, "green");
    assert.throws(
      () => groups.update("nope", { label: "x" }),
      (e) => e.code === "NOT_FOUND",
    );
    assert.equal(groups.get("nope"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete is NOT blocked while referenced — its tunnels fall back to ungrouped", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);
    const g = stores.groupStore().create({ label: "Work" });
    const t = seedTunnel(stores, cred.id, { groupId: g.id });
    assert.equal(t.groupId, g.id);
    assert.deepEqual(t.group, { id: g.id, label: "Work", color: "blue" });

    stores.groupStore().delete(g.id); // allowed even though a tunnel references it

    assert.equal(stores.groupStore().get(g.id), null, "group is gone");
    const after = stores.tunnelStore().get(t.id);
    assert.equal(after.groupId, undefined, "tunnel's groupId is cleared");
    assert.equal(after.group, null, "and its resolved group is null");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("delete of an unknown id throws NOT_FOUND", () => {
  const dir = freshDir();
  try {
    const groups = new Stores(dir).groupStore();
    assert.throws(
      () => groups.delete("nope"),
      (e) => e.code === "NOT_FOUND",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reorder rewrites order and appends ids missing from the list (never drops)", () => {
  const dir = freshDir();
  try {
    const groups = new Stores(dir).groupStore();
    const a = groups.create({ label: "A" });
    groups.create({ label: "B" }); // stays, gets appended after the reordered ids
    const c = groups.create({ label: "C" });
    assert.deepEqual(
      groups.list().map((g) => g.label),
      ["A", "B", "C"],
    );

    // Reorder with a partial list: C then A; B is missing → appended after.
    const out = groups.reorder([c.id, a.id]);
    assert.deepEqual(
      out.map((g) => g.label),
      ["C", "A", "B"],
    );
    assert.deepEqual(
      out.map((g) => g.order),
      [0, 1, 2],
      "order re-derived from the new positions",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a tunnel with a dangling groupId is rejected on create and update", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);

    assert.throws(
      () => seedTunnel(stores, cred.id, { groupId: "no-such-group" }),
      (e) => e.code === "INVALID_DEFINITION" && Boolean(e.errors.groupId),
    );

    const t = seedTunnel(stores, cred.id); // ungrouped is fine
    assert.equal(t.group, null);
    assert.throws(
      () =>
        stores.tunnelStore().update(t.id, {
          name: "t",
          localPort: 1234,
          destination: { host: "h", port: 80 },
          sshHost: "h",
          credentialId: cred.id,
          groupId: "no-such-group",
        }),
      (e) => e.code === "INVALID_DEFINITION" && Boolean(e.errors.groupId),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("omitting groupId on update moves a grouped tunnel to Ungrouped", () => {
  const dir = freshDir();
  try {
    const stores = new Stores(dir);
    const cred = seedCredential(stores);
    const g = stores.groupStore().create({ label: "Work" });
    const t = seedTunnel(stores, cred.id, { groupId: g.id });
    assert.equal(t.groupId, g.id);

    // A full editor payload with no groupId key ⇒ user cleared membership.
    const updated = stores.tunnelStore().update(t.id, {
      name: "t",
      localPort: 1234,
      destination: { host: "h", port: 80 },
      sshHost: "h",
      credentialId: cred.id,
    });
    assert.equal(updated.groupId, undefined);
    assert.equal(updated.group, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
