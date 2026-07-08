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
// from a prior test out of the picture.
test.beforeEach(() => {
  crypto._setSafeStorage(null);
  crypto.configure({ mode: "app-key", appKey: randomBytes(32) });
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
