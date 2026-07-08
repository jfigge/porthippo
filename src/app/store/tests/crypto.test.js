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
const { randomBytes } = require("node:crypto");

const crypto = require("../crypto");

// Each test sets its own backend explicitly; this baseline keeps a stray leak
// from a prior test (safeStorage mock, app key, or session master key) out of the
// picture.
test.beforeEach(() => {
  crypto._setSafeStorage(null);
  crypto.configure({
    mode: "app-key",
    appKey: randomBytes(32),
    masterKey: null,
  });
});

test("app-key: round-trips a secret through enck:v1: ciphertext", () => {
  const key = randomBytes(32);
  crypto.configure({ mode: "app-key", appKey: key });

  const enc = crypto.encryptString("s3cr3t");
  assert.ok(enc.startsWith("enck:v1:"), "carries the app-key prefix");
  assert.ok(
    !enc.includes("s3cr3t"),
    "plaintext does not survive in ciphertext",
  );
  assert.ok(crypto.isEncrypted(enc));
  assert.equal(crypto.decryptString(enc), "s3cr3t");
});

test("encryptString is idempotent and a no-op on empty/plaintext", () => {
  const enc = crypto.encryptString("x");
  assert.equal(
    crypto.encryptString(enc),
    enc,
    "already-encrypted passes through",
  );
  assert.equal(crypto.encryptString(""), "");
  assert.equal(crypto.decryptString("not-encrypted"), "not-encrypted");
});

test("isEncrypted only recognises the at-rest prefixes", () => {
  assert.equal(crypto.isEncrypted("plain"), false);
  assert.equal(crypto.isEncrypted(""), false);
  assert.equal(crypto.isEncrypted(null), false);
  assert.equal(crypto.isEncrypted(42), false);
  assert.equal(crypto.isEncrypted("enc:v1:AAAA"), true);
  assert.equal(crypto.isEncrypted("enck:v1:AAAA"), true);
  assert.equal(crypto.isEncrypted("encm:v1:AAAA"), true);
});

test("app-key: decrypting under the wrong key throws DecryptError", () => {
  crypto.configure({ mode: "app-key", appKey: randomBytes(32) });
  const enc = crypto.encryptString("secret");
  crypto.configure({ appKey: randomBytes(32) }); // rotate the key out
  assert.throws(
    () => crypto.decryptString(enc),
    (err) =>
      err instanceof crypto.DecryptError && err.code === "decrypt-failed",
  );
});

test("app-key: a missing key surfaces as DecryptError, not a crash", () => {
  crypto.configure({ mode: "app-key", appKey: null });
  assert.throws(
    () => crypto.decryptString("enck:v1:AAAA"),
    (err) =>
      err instanceof crypto.DecryptError && err.code === "decrypt-failed",
  );
});

test("os-keychain: seals via safeStorage and decrypts back", () => {
  const mock = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`KS:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(3),
  };
  crypto._setSafeStorage(mock);
  crypto.configure({ mode: "os-keychain", appKey: null });

  const enc = crypto.encryptString("hello");
  assert.ok(enc.startsWith("enc:v1:"));
  assert.equal(crypto.decryptString(enc), "hello");

  // A safeStorage that throws on decrypt → decrypt-failed.
  crypto._setSafeStorage({
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => {
      throw new Error("bad blob");
    },
  });
  assert.throws(
    () => crypto.decryptString(enc),
    (err) => err.code === "decrypt-failed",
  );

  // Keystore gone entirely → encryption-unavailable.
  crypto._setSafeStorage(null);
  assert.throws(
    () => crypto.decryptString(enc),
    (err) => err.code === "encryption-unavailable",
  );
});

test("either backend can decrypt the other's ciphertext when both keys are loaded", () => {
  // Seal one value with the app key, another via the keystore mock, then load
  // both and confirm prefix-dispatch decrypts each.
  const appKey = randomBytes(32);
  crypto._setSafeStorage(null);
  crypto.configure({ mode: "app-key", appKey });
  const encApp = crypto.encryptString("from-app-key");

  crypto._setSafeStorage({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`KS:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(3),
  });
  crypto.configure({ mode: "os-keychain", appKey }); // app key still loaded
  const encKs = crypto.encryptString("from-keystore");

  assert.equal(crypto.decryptString(encApp), "from-app-key");
  assert.equal(crypto.decryptString(encKs), "from-keystore");
  crypto._setSafeStorage(null);
});

// ── Master-password family (Feature 90) ────────────────────────────────────────

test("master-password: round-trips through encm:v1: ciphertext", () => {
  const masterKey = randomBytes(32);
  crypto.configure({ mode: "master-password", appKey: null, masterKey });
  assert.equal(crypto.isLocked(), false);

  const enc = crypto.encryptString("s3cr3t-passphrase");
  assert.ok(enc.startsWith("encm:v1:"), "carries the master prefix");
  assert.ok(!enc.includes("s3cr3t-passphrase"), "plaintext does not survive");
  assert.ok(crypto.isEncrypted(enc));
  assert.equal(crypto.decryptString(enc), "s3cr3t-passphrase");
});

test("master-password: locking refuses to read or seal, with reason 'locked'", () => {
  const masterKey = randomBytes(32);
  crypto.configure({ mode: "master-password", appKey: null, masterKey });
  const enc = crypto.encryptString("keep me");

  crypto.lock();
  assert.equal(crypto.isLocked(), true);

  // Reading a locked value is distinct from a corrupt one (so the UI can prompt
  // to unlock rather than treat the secret as lost).
  assert.throws(
    () => crypto.decryptString(enc),
    (err) => err instanceof crypto.DecryptError && err.code === "locked",
  );
  // Sealing while locked refuses rather than silently downgrading to plaintext.
  assert.throws(
    () => crypto.encryptString("new secret"),
    (err) => err instanceof crypto.DecryptError && err.code === "locked",
  );
});

test("isLocked is true only in master-password mode with no key loaded", () => {
  crypto.configure({
    mode: "app-key",
    appKey: randomBytes(32),
    masterKey: null,
  });
  assert.equal(crypto.isLocked(), false);

  crypto.configure({ mode: "master-password", appKey: null, masterKey: null });
  assert.equal(crypto.isLocked(), true);

  crypto.setMasterKey(randomBytes(32));
  assert.equal(crypto.isLocked(), false);
});

test("deriveKey is deterministic, 32 bytes, and salt/password-sensitive", () => {
  const salt = randomBytes(16);
  const a = crypto.deriveKey("hunter2", salt, 1000);
  const b = crypto.deriveKey("hunter2", salt, 1000);
  assert.equal(a.length, 32);
  assert.deepEqual(a, b, "same inputs → same key");
  assert.notDeepEqual(
    a,
    crypto.deriveKey("hunter2", randomBytes(16), 1000),
    "a different salt → a different key",
  );
  assert.notDeepEqual(
    a,
    crypto.deriveKey("other", salt, 1000),
    "a different password → a different key",
  );
});

test("reencryptValue converts a secret across all three families", () => {
  const appKey = randomBytes(32);
  const masterKey = randomBytes(32);
  const mock = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`KS:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(3),
  };
  crypto._setSafeStorage(mock);
  // All keys loaded so decrypt-by-prefix works whatever the source family is.
  crypto.configure({ mode: "app-key", appKey, masterKey });

  const encApp = crypto.encryptString("hunter2"); // enck:
  assert.ok(encApp.startsWith("enck:v1:"));

  const toMaster = crypto.reencryptValue(encApp, "master-password");
  assert.ok(toMaster.startsWith("encm:v1:"));
  assert.equal(crypto.decryptString(toMaster), "hunter2");

  const toKeychain = crypto.reencryptValue(toMaster, "os-keychain");
  assert.ok(toKeychain.startsWith("enc:v1:"));
  assert.equal(crypto.decryptString(toKeychain), "hunter2");

  const backToApp = crypto.reencryptValue(toKeychain, "app-key");
  assert.ok(backToApp.startsWith("enck:v1:"));
  assert.equal(crypto.decryptString(backToApp), "hunter2");

  crypto._setSafeStorage(null);
});

test("reencryptValue is idempotent for a value already in the target family", () => {
  const appKey = randomBytes(32);
  crypto.configure({ mode: "app-key", appKey });
  const enc = crypto.encryptString("unchanged");
  assert.equal(
    crypto.reencryptValue(enc, "app-key"),
    enc,
    "same-family reseal is a no-op (safe to re-run after a crash)",
  );
});

test("reencryptValue to a locked master backend refuses with 'locked'", () => {
  const appKey = randomBytes(32);
  crypto.configure({ mode: "app-key", appKey, masterKey: null });
  const enc = crypto.encryptString("secret");
  assert.throws(
    () => crypto.reencryptValue(enc, "master-password"),
    (err) => err instanceof crypto.DecryptError && err.code === "locked",
  );
});
