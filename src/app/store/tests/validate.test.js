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
} = require("../validate");

function validDef(over = {}) {
  return {
    name: "prod db",
    localPort: 5432,
    bindHost: "127.0.0.1",
    destination: { host: "db.internal", port: 5432 },
    sshServer: {
      host: "bastion.example.com",
      port: 22,
      user: "jason",
      auth: [{ type: "agent" }],
    },
    jumps: [],
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

test("sshServer is required and validated as a hop", () => {
  assert.ok(
    validateDefinition(validDef({ sshServer: undefined })).errors.sshServer,
  );
  const noUser = validateDefinition(
    validDef({ sshServer: { host: "h", port: 22, auth: [{ type: "agent" }] } }),
  );
  assert.ok(noUser.errors["sshServer.user"]);
});

test("a hop must offer at least one auth method", () => {
  const { errors } = validateDefinition(
    validDef({ sshServer: { host: "h", port: 22, user: "u", auth: [] } }),
  );
  assert.ok(errors["sshServer.auth"]);
});

test("auth entries are validated per type", () => {
  const badType = validateDefinition(
    validDef({
      sshServer: { host: "h", port: 22, user: "u", auth: [{ type: "totp" }] },
    }),
  );
  assert.ok(badType.errors["sshServer.auth[0].type"]);

  const keyNoPath = validateDefinition(
    validDef({
      sshServer: { host: "h", port: 22, user: "u", auth: [{ type: "key" }] },
    }),
  );
  assert.ok(keyNoPath.errors["sshServer.auth[0].privateKeyPath"]);

  // A password auth with no value is fine (write-only secret may be set later).
  const pwNoValue = validateDefinition(
    validDef({
      sshServer: {
        host: "h",
        port: 22,
        user: "u",
        auth: [{ type: "password" }],
      },
    }),
  );
  assert.equal(pwNoValue.valid, true);
});

test("the jump chain is validated element by element", () => {
  assert.ok(validateDefinition(validDef({ jumps: "nope" })).errors.jumps);
  const badJump = validateDefinition(
    validDef({
      jumps: [{ host: "", port: 22, user: "u", auth: [{ type: "agent" }] }],
    }),
  );
  assert.ok(badJump.errors["jumps[0].host"]);
});

test("lingerMs / keepAlive / name are type-checked", () => {
  assert.ok(validateDefinition(validDef({ lingerMs: -1 })).errors.lingerMs);
  assert.ok(
    validateDefinition(validDef({ keepAlive: "yes" })).errors.keepAlive,
  );
  assert.ok(validateDefinition(validDef({ name: "" })).errors.name);
});

test("autoReconnect is an optional boolean", () => {
  // Absent is fine (it defaults to false in the store).
  assert.equal(validateDefinition(validDef()).valid, true);
  assert.equal(
    validateDefinition(validDef({ autoReconnect: true })).valid,
    true,
  );
  assert.equal(
    validateDefinition(validDef({ autoReconnect: false })).valid,
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

test("the auth taxonomy maps types to their secret field", () => {
  assert.deepEqual(AUTH_TYPES, ["agent", "key", "password"]);
  assert.equal(secretFieldForAuthType("password"), "password");
  assert.equal(secretFieldForAuthType("key"), "passphrase");
  assert.equal(secretFieldForAuthType("agent"), null);
  assert.equal(secretFieldForAuthType("bogus"), null);
});
