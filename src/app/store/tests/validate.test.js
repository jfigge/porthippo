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
  AUTH_TYPES,
  secretFieldForAuthType,
  validateDefinition,
  validateCredential,
  validateJumpHost,
} = require("../validate");

function validDef(over = {}) {
  return {
    name: "prod db",
    localPort: 5432,
    bindHost: "127.0.0.1",
    destination: { host: "db.internal", port: 5432 },
    sshHost: "db.internal",
    credentialId: "cred-1",
    jumpHostIds: [],
    lingerMs: 10000,
    keepAlive: false,
    ...over,
  };
}

test("a well-formed definition validates clean", () => {
  const { valid, errors } = validateDefinition(validDef());
  assert.equal(valid, true);
  assert.deepEqual(errors, {});
});

test("the target server (sshHost) is required; sshPort is optional", () => {
  // A target server is mandatory — absent or blank is rejected against its key.
  assert.ok(
    validateDefinition(validDef({ sshHost: undefined })).errors.sshHost,
  );
  assert.ok(validateDefinition(validDef({ sshHost: "" })).errors.sshHost);
  // Present and well-formed is fine, with or without an explicit SSH port.
  assert.equal(
    validateDefinition(validDef({ sshHost: "bastion", sshPort: 2222 })).valid,
    true,
  );
  assert.equal(
    validateDefinition(validDef({ sshPort: undefined })).valid,
    true,
  );
  // A malformed SSH port is rejected against its own key.
  assert.ok(validateDefinition(validDef({ sshPort: 0 })).errors.sshPort);
});

test("entryAddress / exitAddress are optional strings", () => {
  assert.equal(
    validateDefinition(validDef({ entryAddress: "5432", exitAddress: "" }))
      .valid,
    true,
  );
  assert.ok(
    validateDefinition(validDef({ entryAddress: 5432 })).errors.entryAddress,
  );
  assert.ok(
    validateDefinition(validDef({ exitAddress: {} })).errors.exitAddress,
  );
});

test("localPort out of range is rejected with a field-keyed error", () => {
  const { valid, errors } = validateDefinition(validDef({ localPort: 99999 }));
  assert.equal(valid, false);
  assert.ok(errors.localPort, "localPort error present");
});

test("non-integer / zero ports are rejected", () => {
  assert.equal(validateDefinition(validDef({ localPort: 0 })).valid, false);
  assert.equal(
    validateDefinition(validDef({ localPort: 5432.5 })).valid,
    false,
  );
  assert.equal(
    validateDefinition(validDef({ localPort: "5432" })).valid,
    false,
  );
});

test("a missing / malformed destination is rejected", () => {
  assert.ok(
    validateDefinition(validDef({ destination: undefined })).errors.destination,
  );
  const badPort = validateDefinition(
    validDef({ destination: { host: "h", port: 0 } }),
  );
  assert.ok(badPort.errors["destination.port"]);
  const badHost = validateDefinition(
    validDef({ destination: { host: "", port: 5432 } }),
  );
  assert.ok(badHost.errors["destination.host"]);
});

test("a credentialId is structurally required", () => {
  assert.ok(
    validateDefinition(validDef({ credentialId: undefined })).errors
      .credentialId,
  );
  assert.ok(
    validateDefinition(validDef({ credentialId: "" })).errors.credentialId,
  );
});

test("jumpHostIds must be an array of strings when present", () => {
  assert.ok(
    validateDefinition(validDef({ jumpHostIds: "nope" })).errors.jumpHostIds,
  );
  const badEntry = validateDefinition(validDef({ jumpHostIds: ["a", 5, ""] }));
  assert.ok(badEntry.errors["jumpHostIds[1]"]);
  assert.ok(badEntry.errors["jumpHostIds[2]"]);
  assert.equal(
    validateDefinition(validDef({ jumpHostIds: ["a", "b"] })).valid,
    true,
  );
});

test("lingerMs / keepAlive / name are type-checked", () => {
  assert.ok(validateDefinition(validDef({ lingerMs: -1 })).errors.lingerMs);
  assert.ok(
    validateDefinition(validDef({ keepAlive: "yes" })).errors.keepAlive,
  );
  assert.ok(validateDefinition(validDef({ name: "" })).errors.name);
});

test("autoReconnect is an optional boolean", () => {
  assert.equal(validateDefinition(validDef()).valid, true);
  assert.equal(
    validateDefinition(validDef({ autoReconnect: true })).valid,
    true,
  );
  assert.ok(
    validateDefinition(validDef({ autoReconnect: "yes" })).errors.autoReconnect,
  );
});

test("a non-object definition is rejected wholesale", () => {
  assert.equal(validateDefinition(null).valid, false);
  assert.equal(validateDefinition([]).valid, false);
  assert.equal(validateDefinition("x").valid, false);
});

// ── Credentials ────────────────────────────────────────────────────────────

test("a well-formed credential validates clean per auth type", () => {
  assert.equal(
    validateCredential({ label: "L", user: "u", authType: "agent" }).valid,
    true,
  );
  assert.equal(
    validateCredential({
      label: "L",
      user: "u",
      authType: "key",
      keyPath: "/k",
    }).valid,
    true,
  );
  // A password auth with no value is fine (write-only secret set later).
  assert.equal(
    validateCredential({ label: "L", user: "u", authType: "password" }).valid,
    true,
  );
});

test("credential label / user / authType are required, keyPath for key auth", () => {
  assert.ok(validateCredential({ user: "u", authType: "agent" }).errors.label);
  assert.ok(validateCredential({ label: "L", authType: "agent" }).errors.user);
  assert.ok(
    validateCredential({ label: "L", user: "u", authType: "totp" }).errors
      .authType,
  );
  assert.ok(
    validateCredential({ label: "L", user: "u", authType: "key" }).errors
      .keyPath,
  );
});

// ── Jump hosts ─────────────────────────────────────────────────────────────

test("a well-formed jump host validates clean", () => {
  const { valid, errors } = validateJumpHost({
    label: "relay",
    host: "relay.internal",
    port: 22,
    credentialId: "cred-1",
  });
  assert.equal(valid, true);
  assert.deepEqual(errors, {});
});

test("jump host label / host / port / credentialId are checked", () => {
  const bad = validateJumpHost({
    label: "",
    host: "",
    port: 0,
    credentialId: "",
  });
  assert.ok(bad.errors.label);
  assert.ok(bad.errors.host);
  assert.ok(bad.errors.port);
  assert.ok(bad.errors.credentialId);
});

// ── Auth taxonomy ──────────────────────────────────────────────────────────

test("the auth taxonomy maps types to their secret field", () => {
  assert.deepEqual(AUTH_TYPES, ["agent", "key", "password"]);
  assert.equal(secretFieldForAuthType("password"), "password");
  assert.equal(secretFieldForAuthType("key"), "passphrase");
  assert.equal(secretFieldForAuthType("agent"), null);
  assert.equal(secretFieldForAuthType("bogus"), null);
});
