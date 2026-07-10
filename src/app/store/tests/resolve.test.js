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
  resolveDefinition,
  summariseRoute,
  credentialToAuth,
} = require("../resolve");

// Decrypted credentials (plaintext secrets), as the tunnel store passes them in.
const CREDS = {
  pw: { id: "pw", user: "jason", authType: "password", password: "s3cr3t" },
  key: {
    id: "key",
    user: "deploy",
    authType: "key",
    keyPath: "/k",
    passphrase: "phr",
  },
  agent: { id: "agent", user: "hop", authType: "agent" },
};
const JUMPS = {
  j1: {
    id: "j1",
    label: "relay1",
    host: "relay1.internal",
    port: 2200,
    credentialId: "agent",
  },
  j2: {
    id: "j2",
    label: "relay2",
    host: "relay2.internal",
    port: 22,
    credentialId: "key",
  },
};

function baseTunnel(over = {}) {
  return {
    id: "t1",
    name: "db",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    credentialId: "pw",
    jumpHostIds: [],
    ...over,
  };
}

test("a blank sshHost implies the destination box + loopback forward", () => {
  const out = resolveDefinition(baseTunnel(), {
    credentialsById: CREDS,
    jumpHostsById: JUMPS,
  });
  assert.equal(out.sshServer.host, "db.internal");
  assert.equal(out.sshServer.port, 22);
  assert.equal(out.sshServer.user, "jason");
  assert.deepEqual(out.sshServer.auth, [
    { type: "password", password: "s3cr3t" },
  ]);
  assert.deepEqual(out.destination, { host: "127.0.0.1", port: 5432 });
  assert.equal(out.bindHost, "127.0.0.1");
});

test("a non-blank sshHost is a bastion forwarding to the dest host", () => {
  const out = resolveDefinition(
    baseTunnel({ sshHost: "bastion", sshPort: 2222 }),
    { credentialsById: CREDS, jumpHostsById: JUMPS },
  );
  assert.equal(out.sshServer.host, "bastion");
  assert.equal(out.sshServer.port, 2222);
  assert.deepEqual(out.destination, { host: "db.internal", port: 5432 });
});

test("bindHost / sshPort fall back to their defaults", () => {
  const out = resolveDefinition(baseTunnel({ bindHost: "0.0.0.0" }), {
    credentialsById: CREDS,
  });
  assert.equal(out.bindHost, "0.0.0.0"); // explicit override preserved
  assert.equal(out.sshServer.port, 22); // default
});

test("the jump chain resolves in order with each hop's credential", () => {
  const out = resolveDefinition(baseTunnel({ jumpHostIds: ["j1", "j2"] }), {
    credentialsById: CREDS,
    jumpHostsById: JUMPS,
  });
  assert.equal(out.jumps.length, 2);
  assert.equal(out.jumps[0].host, "relay1.internal");
  assert.equal(out.jumps[0].port, 2200);
  assert.deepEqual(out.jumps[0].auth, [{ type: "agent" }]);
  assert.equal(out.jumps[1].host, "relay2.internal");
  assert.deepEqual(out.jumps[1].auth, [
    { type: "key", privateKeyPath: "/k", passphrase: "phr" },
  ]);
});

test("a missing credential yields empty auth; a missing jump host fails closed", () => {
  const noCred = resolveDefinition(baseTunnel({ credentialId: "gone" }), {
    credentialsById: CREDS,
  });
  assert.deepEqual(noCred.sshServer.auth, []);

  const badJump = resolveDefinition(baseTunnel({ jumpHostIds: ["ghost"] }), {
    credentialsById: CREDS,
    jumpHostsById: JUMPS,
  });
  assert.deepEqual(badJump.jumps, [{ host: "", port: 22, user: "", auth: [] }]);
});

test("credentialToAuth maps each auth type to the engine entry shape", () => {
  assert.deepEqual(credentialToAuth(CREDS.agent), [{ type: "agent" }]);
  assert.deepEqual(credentialToAuth(CREDS.pw), [
    { type: "password", password: "s3cr3t" },
  ]);
  assert.deepEqual(credentialToAuth(CREDS.key), [
    { type: "key", privateKeyPath: "/k", passphrase: "phr" },
  ]);
  // A decrypt failure is carried through so the engine skips the method.
  assert.deepEqual(
    credentialToAuth({
      authType: "password",
      password: "",
      decryptError: "EKEY",
    }),
    [{ type: "password", decryptError: "EKEY" }],
  );
  assert.deepEqual(credentialToAuth(undefined), []);
});

test("summariseRoute renders direct, bastion and jump variants", () => {
  assert.equal(
    summariseRoute(
      baseTunnel({ destination: { host: "db.example.com", port: 5432 } }),
    ),
    ":5432 → db.example.com:5432",
  );
  assert.equal(
    summariseRoute(baseTunnel({ sshHost: "bastion" })),
    ":5432 → db.internal:5432  via bastion",
  );
  assert.equal(
    summariseRoute(
      baseTunnel({ sshHost: "bastion", jumpHostIds: ["j1", "j2"] }),
      {
        jumpHostsById: JUMPS,
      },
    ),
    ":5432 → db.internal:5432  via bastion  (jump: relay1, relay2)",
  );
  // Unknown jump id falls back to the id itself.
  assert.equal(
    summariseRoute(baseTunnel({ jumpHostIds: ["ghost"] }), {
      jumpHostsById: JUMPS,
    }),
    ":5432 → db.internal:5432  (jump: ghost)",
  );
});
