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

/**
 * crypto.js — Encryption helpers for secrets at rest (SSH passwords + key
 * passphrases). Ported down from Rest Hippo's crypto.js.
 *
 * Three at-rest ciphertext families, each self-identifying by prefix so
 * decryption dispatches on the value alone (which keeps a mix — e.g. during a
 * backend switch or a platform move — readable as long as the needed key is
 * loaded):
 *   enc:v1:   OS keystore  (Electron safeStorage — macOS Keychain / Windows DPAPI
 *             / Linux libsecret; the key never materialises in JS)
 *   enck:v1:  app key      (a random 256-bit key in a 0600 file under userData;
 *             AES-256-GCM). The promptless DEFAULT — a background tunnel manager
 *             must not fire a Keychain prompt on every launch.
 *   encm:v1:  master pass  (a PBKDF2-derived key held IN MEMORY for the session
 *             only; AES-256-GCM). Boots LOCKED — the key is absent until the user
 *             unlocks, so an encm: value can't be decrypted until then.
 *
 * All encrypt/decrypt runs in the Electron main process; the renderer only ever
 * receives a `hasSecret` flag, never a decrypted value (see tunnel-store.js).
 *
 * The active backend + its key are set once at bootstrap via {@link configure}
 * (see secret-storage.js) BEFORE the first decrypt. When neither a keystore nor
 * an app key is available (a plain unit-test process), os-keychain encrypt is a
 * no-op that returns its input — so tests that need real ciphertext configure
 * app-key mode.
 */
"use strict";

// safeStorage is only present inside an Electron main process. Guard against a
// plain `node --test` process where Electron's runtime APIs are absent.
let _safeStorage = null;
try {
  const electron = require("electron");
  _safeStorage = electron.safeStorage ?? null;
} catch {
  /* not running inside Electron */
}

const nodeCrypto = require("crypto");

// ── At-rest ciphertext families (self-identifying prefixes) ───────────────────
const PREFIX = "enc:v1:"; // os-keychain (Electron safeStorage)
const PREFIX_APPKEY = "enck:v1:"; // app-key (AES-256-GCM under the key file)
const PREFIX_MASTER = "encm:v1:"; // master-password (AES-256-GCM under a PBKDF2 key)
const AT_REST_PREFIXES = [PREFIX, PREFIX_APPKEY, PREFIX_MASTER];

// AES-256-GCM wire constants for the app-key + master-password families.
const IV_LEN = 12; // GCM standard nonce length
const TAG_LEN = 16;

// Master-password key derivation. PBKDF2-HMAC-SHA256 with a high iteration count
// so a stolen `secret-storage.json` (which carries the salt) is expensive to
// brute-force. 210,000 matches the OWASP 2023 PBKDF2-SHA256 guidance.
const PBKDF2_ITERATIONS = 210000;
const DERIVED_KEY_LEN = 32; // AES-256

// ── Active backend — set once at bootstrap via configure() ─────────────────────
// The default "os-keychain" preserves the historical no-key behaviour for any
// caller that never calls configure() (the unit tests, which run in no-op mode).
let _activeMode = "os-keychain";
let _appKey = null; // Buffer(32) when app-key mode is active
let _masterKey = null; // Buffer(32) when the master password is unlocked this session

/**
 * Configure the active at-rest backend and its key(s). Called once at startup
 * (the secret-storage bootstrap) BEFORE the first decrypt, and again on a mode
 * switch / unlock. Any omitted field is left unchanged — so loading the master
 * key on unlock doesn't disturb an app key kept around for mixed-store reads.
 * @param {{mode?:string, appKey?:Buffer|null, masterKey?:Buffer|null}} opts
 */
function configure({ mode, appKey, masterKey } = {}) {
  if (mode !== undefined) _activeMode = mode;
  if (appKey !== undefined) _appKey = appKey;
  if (masterKey !== undefined) _masterKey = masterKey;
}

/** The active at-rest mode: "os-keychain" | "app-key" | "master-password". */
function getMode() {
  return _activeMode;
}

/** The self-identifying ciphertext prefix a backend seals with. */
function _prefixFor(backend) {
  switch (backend) {
    case "os-keychain":
      return PREFIX;
    case "app-key":
      return PREFIX_APPKEY;
    case "master-password":
      return PREFIX_MASTER;
    default:
      throw new Error(`unknown secret-storage backend: ${backend}`);
  }
}

/**
 * Derive a 32-byte AES key from a master password. Pure and deterministic for a
 * given (password, salt, iterations), so secret-storage can both mint a key when
 * a password is first set and re-derive it to verify an unlock attempt.
 * @param {string} password
 * @param {Buffer} salt
 * @param {number} [iterations]
 * @returns {Buffer} 32 bytes
 */
function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  return nodeCrypto.pbkdf2Sync(
    password,
    salt,
    iterations,
    DERIVED_KEY_LEN,
    "sha256",
  );
}

/**
 * Load the session master key (an unlock). Held in memory only; never persisted.
 * @param {Buffer|null} key
 */
function setMasterKey(key) {
  _masterKey = key;
}

/** Drop the session master key (re-lock master-password mode). */
function lock() {
  _masterKey = null;
}

/**
 * True when master-password mode is active but the key hasn't been unlocked this
 * session — so any encm: secret is currently unreadable. Other modes are never
 * "locked".
 */
function isLocked() {
  return _activeMode === "master-password" && _masterKey === null;
}

/** AES-256-GCM seal → iv(12)|tag(16)|ct (the caller supplies the key). */
function _aesGcmEncrypt(plaintext, key) {
  const iv = nodeCrypto.randomBytes(IV_LEN);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** AES-256-GCM open of an iv|tag|ct blob (throws on a short blob or bad tag). */
function _aesGcmDecrypt(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < IV_LEN + TAG_LEN) {
    throw new Error("malformed");
  }
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = nodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * Tagged error thrown when an encrypted value cannot be turned back into
 * plaintext — because the OS keystore is unavailable for data marked encrypted,
 * because master-password mode is locked (its key isn't loaded), or because
 * decryption threw (corrupted blob, keystore/profile mismatch, rotated key,
 * missing app key).
 *
 * It deliberately carries NO secret material — only a machine-readable code — so
 * it is safe to log and to surface to the renderer. `.code` is the project-wide
 * error discriminator (see io.js and the note in main.js).
 */
class DecryptError extends Error {
  /** @param {"encryption-unavailable"|"decrypt-failed"|"locked"} code */
  constructor(code) {
    super(`decrypt failed: ${code}`);
    this.name = "DecryptError";
    this.code = code;
  }
}

/**
 * Test seam: replace the captured safeStorage handle. Production never calls
 * this; the unit tests inject a mock to exercise the os-keychain path (and its
 * failure branch) in a plain Node process. Pass `null` to restore the
 * unavailable state.
 *
 * @param {{isEncryptionAvailable:Function,encryptString:Function,decryptString:Function}|null} mock
 */
function _setSafeStorage(mock) {
  _safeStorage = mock;
}

/** True when OS-level encryption is available and functional. */
function isAvailable() {
  return _safeStorage !== null && _safeStorage.isEncryptionAvailable();
}

/**
 * True when `value` is at-rest ciphertext from any backend (os-keychain
 * `enc:v1:`, app-key `enck:v1:`, or master-password `encm:v1:`). Used by the
 * decrypt + anti-clobber paths, so it must recognise every family.
 * @param {unknown} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return (
    typeof value === "string" &&
    AT_REST_PREFIXES.some((p) => value.startsWith(p))
  );
}

let _warnedUnavailable = false;

/**
 * Seal a plaintext value under an explicit backend.
 * @param {string} plain
 * @param {string} backend
 * @returns {string}
 */
function _rawEncryptTo(plain, backend) {
  switch (backend) {
    case "os-keychain": {
      if (!isAvailable()) {
        // SECURITY: keystore unavailable → this secret would be written as
        // cleartext. Surface once per process so a silent plaintext-at-rest
        // downgrade doesn't go unnoticed. (The app-key default avoids this on the
        // normal path; this branch is the no-op test / misconfigured mode. A real
        // switch TO os-keychain is refused upstream when the keystore is absent.)
        if (!_warnedUnavailable) {
          _warnedUnavailable = true;
          console.warn(
            "[crypto] OS keystore unavailable — a secret is being stored UNENCRYPTED. " +
              "On Linux, ensure a Secret Service provider (e.g. gnome-keyring) is running.",
          );
        }
        return plain;
      }
      return PREFIX + _safeStorage.encryptString(plain).toString("base64");
    }
    case "app-key": {
      // The app key is generated at bootstrap whenever app-key mode is active, so
      // a missing key here is a configuration bug, not a normal state.
      if (!_appKey) throw new DecryptError("decrypt-failed");
      return PREFIX_APPKEY + _aesGcmEncrypt(plain, _appKey).toString("base64");
    }
    case "master-password": {
      // No key loaded ⇒ master-password mode is locked; refuse rather than write
      // an unusable (or worse, plaintext) value.
      if (!_masterKey) throw new DecryptError("locked");
      return (
        PREFIX_MASTER + _aesGcmEncrypt(plain, _masterKey).toString("base64")
      );
    }
    default:
      throw new Error(`unknown secret-storage backend: ${backend}`);
  }
}

/**
 * Encrypt a plaintext secret under the ACTIVE backend. Returns `plaintext`
 * unchanged when it is empty or already at-rest ciphertext (idempotent, under
 * any backend prefix).
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptString(plaintext) {
  if (!plaintext || isEncrypted(plaintext)) return plaintext;
  return _rawEncryptTo(plaintext, _activeMode);
}

/**
 * Re-seal a value to a DIFFERENT backend (the mode-switch migration primitive).
 * Decrypts by dispatching on the value's own prefix (so the source key must be
 * loaded) then re-encrypts to `targetBackend`. Unlike {@link encryptString},
 * this deliberately does NOT short-circuit on an at-rest prefix — that is exactly
 * the value we need to convert.
 *
 * Idempotent: a value already sealed under the target family passes through
 * untouched, so re-running an interrupted migration only converts the stragglers
 * a crash left in the old family.
 *
 * @param {string} value  an at-rest ciphertext (any family) or bare plaintext
 * @param {string} targetBackend
 * @returns {string} ciphertext under `targetBackend`
 * @throws {DecryptError} if the source can't be decrypted (wrong/absent key)
 */
function reencryptValue(value, targetBackend) {
  if (!value || typeof value !== "string") return value;
  if (value.startsWith(_prefixFor(targetBackend))) return value; // already converted
  const plain = isEncrypted(value) ? decryptString(value) : value;
  if (!plain) return plain;
  return _rawEncryptTo(plain, targetBackend);
}

/**
 * Decrypt an at-rest value by DISPATCHING ON ITS PREFIX — so a value sealed under
 * any backend decrypts as long as that backend's key is loaded. Values with no
 * at-rest prefix are returned as-is (plaintext written by an older / no-op run). A
 * value that IS marked encrypted but cannot be recovered throws a
 * {@link DecryptError}.
 *
 * @param {string} value
 * @returns {string}
 * @throws {DecryptError}
 */
function decryptString(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith(PREFIX)) {
    if (!isAvailable()) throw new DecryptError("encryption-unavailable");
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    try {
      return _safeStorage.decryptString(buf);
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  if (value.startsWith(PREFIX_APPKEY)) {
    if (!_appKey) throw new DecryptError("decrypt-failed");
    try {
      return _aesGcmDecrypt(
        Buffer.from(value.slice(PREFIX_APPKEY.length), "base64"),
        _appKey,
      );
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  if (value.startsWith(PREFIX_MASTER)) {
    // Locked (no key) is distinct from a bad blob: the caller can prompt to
    // unlock rather than treat the secret as corrupt.
    if (!_masterKey) throw new DecryptError("locked");
    try {
      return _aesGcmDecrypt(
        Buffer.from(value.slice(PREFIX_MASTER.length), "base64"),
        _masterKey,
      );
    } catch {
      throw new DecryptError("decrypt-failed");
    }
  }
  return value; // plaintext passthrough
}

module.exports = {
  DecryptError,
  PREFIX,
  PREFIX_APPKEY,
  PREFIX_MASTER,
  PBKDF2_ITERATIONS,
  configure,
  getMode,
  deriveKey,
  setMasterKey,
  lock,
  isLocked,
  isAvailable,
  isEncrypted,
  encryptString,
  reencryptValue,
  decryptString,
  _aesGcmEncrypt,
  _aesGcmDecrypt,
  _setSafeStorage,
};
