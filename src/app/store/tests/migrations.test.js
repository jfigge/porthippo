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

const {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersionOf,
  migrate,
} = require("../migrations");

test("Feature 110 ships schema v3 (two migrations in the chain)", () => {
  assert.equal(BASE_SCHEMA_VERSION, 1);
  assert.equal(MIGRATIONS.length, 2);
  assert.equal(CURRENT_SCHEMA_VERSION, 3);
});

test("migrate stamps the current version + sibling arrays on a tunnels doc", () => {
  assert.deepEqual(migrate({ tunnels: [] }), {
    tunnels: [],
    credentials: [],
    jumpHosts: [],
    schemaVersion: 3,
  });
});

test("migrate leaves an already-current document untouched (same ref)", () => {
  const doc = { schemaVersion: 3, a: 1 };
  assert.equal(migrate(doc), doc);
});

test("migrate passes non-object inputs through unchanged", () => {
  assert.equal(migrate(null), null);
  assert.equal(migrate("plain"), "plain");
  assert.equal(migrate(7), 7);
  const arr = [1, 2, 3];
  assert.equal(migrate(arr), arr); // arrays are not stamped
});

test("a non-tunnels document is stamped but otherwise untouched", () => {
  // Both transforms are type-guarded to the tunnels doc.
  assert.deepEqual(migrate({ theme: "dark" }), {
    theme: "dark",
    schemaVersion: 3,
  });
});

test("schemaVersionOf defaults to the base version when absent/invalid", () => {
  assert.equal(schemaVersionOf({}), 1);
  assert.equal(schemaVersionOf({ schemaVersion: "x" }), 1);
  assert.equal(schemaVersionOf({ schemaVersion: 3 }), 3);
  assert.equal(schemaVersionOf(null), 1);
});

// ── v1 → v2: extract credentials + jump hosts ────────────────────────────────

function v1Doc() {
  return {
    tunnels: [
      {
        id: "t1",
        name: "db",
        localPort: 5432,
        bindHost: "127.0.0.1",
        destination: { host: "db.internal", port: 5432 },
        sshServer: {
          host: "bastion",
          port: 22,
          user: "jason",
          auth: [{ type: "password", password: { enc: "SEALED-PW" } }],
        },
        jumps: [
          { host: "relay", port: 2200, user: "hop", auth: [{ type: "agent" }] },
        ],
        enabled: true,
        keepAlive: false,
        autoReconnect: false,
      },
    ],
  };
}

test("v1→v2 lifts embedded auth into a referenced credential", () => {
  const out = migrate(v1Doc());
  assert.equal(out.schemaVersion, 3);

  const t = out.tunnels[0];
  assert.equal(t.sshServer, undefined, "the embedded hop is gone");
  assert.equal(t.type, "local", "v2→v3 stamps a local forwarding type");
  assert.equal(
    t.sshHost,
    "bastion",
    "sshHost set explicitly (behaviour-preserving)",
  );
  assert.equal(t.sshPort, 22);
  assert.ok(t.credentialId, "references a credential by id");

  const cred = out.credentials.find((c) => c.id === t.credentialId);
  assert.equal(cred.user, "jason");
  assert.equal(cred.authType, "password");
  assert.deepEqual(
    cred.password,
    { enc: "SEALED-PW" },
    "sealed secret relocated verbatim",
  );
});

test("v1→v2 lifts inline jumps into referenced jump hosts (with their own credential)", () => {
  const out = migrate(v1Doc());
  const t = out.tunnels[0];
  assert.equal(t.jumpHostIds.length, 1);

  const jh = out.jumpHosts.find((j) => j.id === t.jumpHostIds[0]);
  assert.equal(jh.host, "relay");
  assert.equal(jh.port, 2200);
  assert.ok(jh.credentialId);

  const jhCred = out.credentials.find((c) => c.id === jh.credentialId);
  assert.equal(jhCred.user, "hop");
  assert.equal(jhCred.authType, "agent");
  // Two credentials total: the server's + the jump host's.
  assert.equal(out.credentials.length, 2);
});

test("v1→v2 dedupes identical credentials across tunnels", () => {
  const doc = {
    tunnels: [
      {
        id: "a",
        name: "a",
        localPort: 1,
        destination: { host: "h", port: 1 },
        sshServer: {
          host: "h",
          port: 22,
          user: "same",
          auth: [{ type: "agent" }],
        },
        jumps: [],
      },
      {
        id: "b",
        name: "b",
        localPort: 2,
        destination: { host: "h", port: 2 },
        sshServer: {
          host: "h2",
          port: 22,
          user: "same",
          auth: [{ type: "agent" }],
        },
        jumps: [],
      },
    ],
  };
  const out = migrate(doc);
  assert.equal(out.credentials.length, 1, "one shared agent credential");
  assert.equal(out.tunnels[0].credentialId, out.tunnels[1].credentialId);
});

// ── v2 → v3: stamp a forwarding type ─────────────────────────────────────────

test("v2→v3 stamps type:local on tunnels that lack one, leaving others", () => {
  const doc = {
    schemaVersion: 2,
    tunnels: [
      { id: "a", name: "a", localPort: 1, sshHost: "h", credentialId: "c" },
      { id: "b", name: "b", type: "dynamic", localPort: 2, sshHost: "h2" },
    ],
    credentials: [],
    jumpHosts: [],
  };
  const out = migrate(doc);
  assert.equal(out.schemaVersion, 3);
  assert.equal(out.tunnels[0].type, "local", "untyped tunnel becomes local");
  assert.equal(out.tunnels[1].type, "dynamic", "an explicit type is preserved");
});

test("v2→v3 is idempotent and doesn't rewrite an all-typed doc", () => {
  const doc = {
    schemaVersion: 3,
    tunnels: [
      { id: "a", name: "a", type: "local", localPort: 1, sshHost: "h" },
    ],
    credentials: [],
    jumpHosts: [],
  };
  assert.equal(migrate(doc), doc, "already current + all typed → same ref");
});

test("v1→v2 is idempotent: a re-run adds nothing", () => {
  const once = migrate(v1Doc());
  // Simulate a re-run against an already-migrated doc (strip the version stamp).
  const again = migrate({ ...once, schemaVersion: undefined });
  assert.deepEqual(again.tunnels, once.tunnels);
  assert.deepEqual(again.credentials, once.credentials);
  assert.deepEqual(again.jumpHosts, once.jumpHosts);
});
