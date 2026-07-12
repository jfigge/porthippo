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
 * secret-storage.js — Owns the at-rest secret-storage backend: its (unencrypted)
 * mode config file, the app-key file, and switching between the three backends
 * (see crypto.js for the ciphertext families):
 *   - "app-key"          a random 256-bit key in a 0600 file. No OS prompt; the
 *                        DEFAULT for a background tunnel manager. enck:v1:
 *   - "os-keychain"      Electron safeStorage (macOS Keychain / Windows DPAPI /
 *                        Linux libsecret). enc:v1:
 *   - "master-password"  a PBKDF2-derived key held in memory for the session
 *                        only; boots LOCKED and must be unlocked each run. encm:v1:
 *
 * The active mode is recorded in an UNENCRYPTED config file (`secret-storage.json`)
 * read at bootstrap BEFORE any decrypt, so resolving the mode never touches the
 * keystore (and so never triggers a Keychain prompt). If that config is ever lost
 * the mode is inferred from the prefix of existing on-disk ciphertext, so we never
 * mint a fresh app key that orphans already-sealed secrets.
 *
 * A mode switch RE-ENCRYPTS every stored secret to the new backend, crash-safely:
 * a durable `migration` marker is written first, the secrets are converted, and
 * the mode is flipped LAST (the atomicity anchor). A crash between the marker and
 * the flip is auto-finished on the next launch by {@link SecretStorage#bootstrap}
 * (no-password directions) or by the unlock handler (master-password directions).
 * No secret is ever downgraded to plaintext: switching to OS keychain when
 * safeStorage is unavailable is refused, and the app-key file is deleted only
 * AFTER a completed switch away from it.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const io = require("./io");
const crypto = require("./crypto");

const CONFIG_VERSION = 1;
const MODES = ["app-key", "os-keychain", "master-password"];
const DEFAULT_MODE = "app-key";

// A fixed constant sealed under the master key; decrypting it back proves the
// entered password is correct (the GCM tag does the verification). Not secret.
const VERIFIER_PLAINTEXT = "porthippo:secret-storage:verifier:v1";
const MASTER_SALT_LEN = 16;

// tunnels.json is Port Hippo's only secret-bearing file; since Feature 45 a
// credential's auth secret lives at `credentials[].{password|passphrase}` as
// `{ enc: "<ciphertext>" }` (tunnels + jump hosts carry no secret of their own).
const SECRET_FIELDS = ["password", "passphrase"];

/**
 * Pick the backend for a fresh install with no existing managed ciphertext.
 *
 * On Windows, Electron safeStorage is backed by DPAPI — real, user-bound at-rest
 * protection with NO prompt — whereas the app-key file's 0600 mode is a no-op
 * there (any local-user process can read it). So when the keystore is available
 * on Windows, os-keychain is the better promptless default. Everywhere else keep
 * app-key: macOS os-keychain shows a Keychain prompt and Linux may have no Secret
 * Service provider, so the no-prompt file is the safer default there.
 *
 * Pure (platform + availability in, mode out) so it is unit-testable without
 * touching process.platform.
 *
 * @param {string} platform           process.platform
 * @param {boolean} keystoreAvailable crypto.isAvailable()
 * @returns {string} a MODES value
 */
function defaultModeFor(platform, keystoreAvailable) {
  if (platform === "win32" && keystoreAvailable) return "os-keychain";
  return DEFAULT_MODE;
}

// ── Secret taxonomy over a tunnels.json document ───────────────────────────────
// A `collect`/`transform` pair sharing one traversal so the two migration passes
// (validate then convert) can never drift over which values are secrets. Secrets
// live only on credential records; the document is read post-migration, so the
// walkers always see the reference (v2) shape.

/** Yield each sealed ciphertext string in a tunnels.json document. */
function collectSecrets(doc) {
  const out = [];
  const credentials = Array.isArray(doc?.credentials) ? doc.credentials : [];
  for (const cred of credentials) {
    if (!cred || typeof cred !== "object") continue;
    for (const field of SECRET_FIELDS) {
      const enc = cred[field]?.enc;
      if (typeof enc === "string") out.push(enc);
    }
  }
  return out;
}

/** A copy of a tunnels.json document with `fn` applied to every ciphertext. */
function mapSecrets(doc, fn) {
  if (!doc || typeof doc !== "object") return doc;
  const credentials = Array.isArray(doc.credentials) ? doc.credentials : [];
  return {
    ...doc,
    credentials: credentials.map((cred) => {
      if (!cred || typeof cred !== "object") return cred;
      const next = { ...cred };
      for (const field of SECRET_FIELDS) {
        const enc = cred[field]?.enc;
        if (typeof enc === "string") {
          next[field] = { ...cred[field], enc: fn(enc) };
        }
      }
      return next;
    }),
  };
}

class SecretStorage {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  // ── Config file ─────────────────────────────────────────────────────────────

  /** Read the secret-storage config, or null if it doesn't exist / is invalid. */
  readConfig() {
    const raw = io.readJSON(this._paths.secretStorageConfigPath());
    if (!raw || typeof raw !== "object" || !MODES.includes(raw.mode)) {
      return null;
    }
    return raw;
  }

  /** Atomically persist the secret-storage config. */
  writeConfig(config) {
    io.writeJSON(this._paths.secretStorageConfigPath(), {
      version: CONFIG_VERSION,
      ...config,
    });
  }

  // ── App key (0600 file) ─────────────────────────────────────────────────────

  /** Read the app-key bytes (Buffer), or null when the key file is absent. */
  readAppKey() {
    try {
      const b64 = fs.readFileSync(this._paths.secretKeyPath(), "utf8").trim();
      const key = Buffer.from(b64, "base64");
      return key.length === 32 ? key : null;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Return the app key, generating + persisting a fresh one if absent.
   *
   * The key file is written 0600 and explicitly chmod'd — io.atomicWrite can't
   * guarantee the mode (it opens with the default 0666 & ~umask), so this uses a
   * dedicated write. On Windows the mode is a no-op; the app-key file has no real
   * OS protection there (that's what os-keychain/DPAPI is for).
   */
  ensureAppKey() {
    const existing = this.readAppKey();
    if (existing) return existing;
    const key = nodeCrypto.randomBytes(32);
    const keyPath = this._paths.secretKeyPath();
    io.ensureDir(path.dirname(keyPath));
    fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    try {
      fs.chmodSync(keyPath, 0o600); // the open-time mode is masked by umask
    } catch {
      /* best-effort (e.g. Windows) */
    }
    return key;
  }

  /** Remove the app-key file (only after a completed switch AWAY from app-key). */
  deleteAppKey() {
    io.remove(this._paths.secretKeyPath());
  }

  // ── Master password (PBKDF2 → AES key) ──────────────────────────────────────

  /**
   * Mint the durable material for a new master password: a random salt, the
   * derived key (held only in memory), and a verifier blob (the fixed plaintext
   * sealed under the key) that later proves an unlock attempt. The salt +
   * iterations + verifier ride the unencrypted `secret-storage.json`; the key
   * itself is never written.
   *
   * @param {string} password
   * @returns {{key:Buffer, kdf:{salt:string,iterations:number}, verifier:string}}
   */
  prepareMasterPassword(password) {
    const salt = nodeCrypto.randomBytes(MASTER_SALT_LEN);
    const iterations = crypto.PBKDF2_ITERATIONS;
    const key = crypto.deriveKey(password, salt, iterations);
    const verifier = crypto._aesGcmEncrypt(VERIFIER_PLAINTEXT, key);
    return {
      key,
      kdf: { salt: salt.toString("base64"), iterations },
      verifier: verifier.toString("base64"),
    };
  }

  /**
   * Verify a candidate master password against a stored config. Re-derives the
   * key from the stored salt and tries to open the verifier; a correct password
   * returns the derived key (ready to load), a wrong one (GCM tag mismatch) or a
   * malformed config returns null.
   *
   * @param {string} password
   * @param {object} config  the stored secret-storage config
   * @returns {Buffer|null} the derived key on success, else null
   */
  verifyMasterPassword(password, config) {
    if (!config || !config.kdf || !config.verifier) return null;
    try {
      const salt = Buffer.from(config.kdf.salt, "base64");
      const key = crypto.deriveKey(password, salt, config.kdf.iterations);
      const got = crypto._aesGcmDecrypt(
        Buffer.from(config.verifier, "base64"),
        key,
      );
      return got === VERIFIER_PLAINTEXT ? key : null;
    } catch {
      return null; // bad password (GCM tag) or malformed verifier
    }
  }

  // ── Bootstrap (called once at startup, before any decrypt) ──────────────────

  /**
   * Resolve the active mode + key and configure crypto, BEFORE any store reads.
   *
   * On a fresh config (first run, or a lost config file) the mode is INFERRED from
   * existing on-disk ciphertext by prefix — master-password (`encm:v1:`) →
   * os-keychain (`enc:v1:`) → app-key (`enck:v1:`) → the platform default — and
   * persisted so it never re-scans. A crash-interrupted no-password migration is
   * finished here; a pending master-password migration (or plain master-password
   * mode) boots LOCKED so the renderer prompts for the passphrase.
   *
   * @returns {{mode:string, locked:boolean}}
   */
  bootstrap() {
    let config = this.readConfig();
    if (!config) config = this._inferAndPersist();

    // Finish a crash-interrupted mode switch. The no-password directions
    // (app-key ↔ os-keychain) complete silently here; a master-password
    // direction is deferred to unlock (boots locked below).
    const marker = this._migrationOf(config);
    if (marker && !this._markerNeedsPassword(marker)) {
      try {
        this.resumeMigration({});
      } catch (err) {
        console.warn(
          `[secret-storage] auto-resume failed: ${err && err.message}`,
        );
      }
      config = this.readConfig() || config; // mode flipped, marker cleared
    }

    // A still-pending master-password migration boots LOCKED in master-password
    // mode so the renderer prompts for the passphrase; the unlock handler then
    // finishes it. Otherwise the mode is exactly what the config records.
    const pending = this._migrationOf(config);
    const mode =
      pending && this._markerNeedsPassword(pending)
        ? "master-password"
        : config.mode;

    // Load the app key whenever the file exists (even in os-keychain /
    // master-password mode) so a mix of families — including values a crashed
    // migration hasn't converted yet — stays decryptable. Only its absence in
    // app-key mode mints a new one.
    const appKey = mode === "app-key" ? this.ensureAppKey() : this.readAppKey();

    crypto.configure({ mode, appKey, masterKey: null });
    return { mode, locked: crypto.isLocked() };
  }

  /** Probe on-disk ciphertext to infer the pre-existing mode, then persist it. */
  _inferAndPersist() {
    const mode = this._inferMode();
    if (mode === "app-key") this.ensureAppKey();
    const config = { mode };
    this.writeConfig(config);
    return config;
  }

  /**
   * Infer the mode for an install with no config file. The config records which
   * backend the at-rest ciphertext was sealed with; if it is lost we must NOT
   * guess a mode that orphans that ciphertext. Probe each family by string prefix
   * (never decrypts — no keychain prompt) and fall back to the platform default
   * only when no managed ciphertext exists at all.
   *
   * SECURITY: probe master-password FIRST. Mis-reading encm: data as app-key
   * would mint a fresh key over unlock-only secrets, orphaning them permanently;
   * inferring master-password when wrong merely boots locked (harmless).
   */
  _inferMode() {
    const startsWith = (prefix) => (v) =>
      typeof v === "string" && v.startsWith(prefix);
    if (this._anySealedSecret(startsWith(crypto.PREFIX_MASTER))) {
      return "master-password";
    }
    if (this._anySealedSecret(startsWith(crypto.PREFIX))) {
      return "os-keychain";
    }
    if (this._anySealedSecret(startsWith(crypto.PREFIX_APPKEY))) {
      return "app-key";
    }
    return defaultModeFor(process.platform, crypto.isAvailable());
  }

  /**
   * Whether ANY sealed secret in tunnels.json satisfies `isHit`. Pure
   * string-prefix work over the ciphertext — never decrypts.
   * @param {(value: string) => boolean} isHit
   */
  _anySealedSecret(isHit) {
    const doc = io.readJSON(this._paths.tunnelsPath());
    return collectSecrets(doc).some(isHit);
  }

  // ── Migration marker (durable, brackets a mode switch) ──────────────────────

  /** The valid `{from,to}` marker in a config, or null. */
  _migrationOf(config) {
    const m = config && config.migration;
    if (!m || typeof m !== "object") return null;
    if (!MODES.includes(m.from) || !MODES.includes(m.to) || m.from === m.to) {
      return null;
    }
    return { from: m.from, to: m.to };
  }

  /** True when either end of a migration is master-password (needs the key). */
  _markerNeedsPassword(marker) {
    return marker.from === "master-password" || marker.to === "master-password";
  }

  /** The pending migration marker (if a switch was interrupted), or null. */
  pendingMigration() {
    return this._migrationOf(this.readConfig());
  }

  /**
   * Durably record an in-flight switch BEFORE any secret is converted. Keeps the
   * mode at `from` (so a crash before the flip still reads the old family) and
   * carries any target key material (`extra` = the master-password kdf/verifier)
   * so the switch can be finished after a crash.
   */
  markMigration(from, to, extra = {}) {
    const config = this.readConfig() || {};
    const preserved = {};
    if (config.kdf) preserved.kdf = config.kdf;
    if (config.verifier) preserved.verifier = config.verifier;
    this.writeConfig({
      ...preserved,
      ...extra,
      mode: from,
      migration: { from, to },
    });
  }

  /** Drop the migration marker (a switch was abandoned before any convert). */
  clearMigration() {
    const config = this.readConfig();
    if (!config || !config.migration) return;
    const { migration: _drop, ...rest } = config;
    this.writeConfig(rest);
  }

  /**
   * Abort an in-flight switch TO master-password: drop the marker AND the
   * kdf/verifier it minted. The mode never flipped, so that key material
   * protects nothing — leaving it behind would make getState().hasPassword
   * report a configured password that doesn't exist and strand a stale verifier
   * as an offline brute-force target. Safe only when the target (not the source)
   * was master-password; a switch AWAY keeps the still-in-use verifier.
   */
  _abortMasterPasswordSwitch() {
    const config = this.readConfig();
    if (!config) return;
    const { migration: _m, kdf: _k, verifier: _v, ...rest } = config;
    this.writeConfig(rest);
  }

  /**
   * Finish a crash-interrupted migration. Loads whatever keys are needed to read
   * `from` and seal to `to`, re-encrypts the stragglers (idempotent), then flips
   * the mode LAST and reconfigures the live backend. A master-password direction
   * with no key returns `needs-unlock` (the unlock handler retries with the key).
   *
   * @param {{masterKey?:Buffer|null}} [opts]
   * @returns {{status:string, from?:string, to?:string, failures?:object[]}}
   */
  resumeMigration({ masterKey = null } = {}) {
    const config = this.readConfig();
    const marker = this._migrationOf(config);
    if (!marker) return { status: "none" };
    const { from, to } = marker;
    if (this._markerNeedsPassword(marker) && !masterKey) {
      return { status: "needs-unlock", from, to };
    }

    // Load every key needed to READ `from` and SEAL to `to`.
    const appKey =
      from === "app-key" || to === "app-key"
        ? this.ensureAppKey()
        : this.readAppKey();
    crypto.configure({ mode: from, appKey, masterKey });

    const result = this.reencryptAll(to);
    if (!result.ok) return { status: "failed", failures: result.failures };

    this._flipMode(to, {
      kdf: config.kdf,
      verifier: config.verifier,
      masterKey,
    });
    return { status: "resumed", from, to };
  }

  // ── Re-encryption (all-or-nothing, two-pass) ────────────────────────────────

  /** The secret-bearing files: Port Hippo has exactly one (tunnels.json). */
  _secretFiles() {
    return [
      {
        path: this._paths.tunnelsPath(),
        label: "tunnels",
        collect: collectSecrets,
        transform: mapSecrets,
      },
    ];
  }

  /**
   * Re-encrypt every stored secret to `targetBackend`, all-or-nothing.
   *
   * Pass 1 VALIDATES: decrypt every secret under the current backend (also
   * coalescing the single macOS Keychain preflight into one place); ANY failure
   * aborts with nothing written. Pass 2 CONVERTS: re-seal each value to the
   * target and write. Because pass 1 proved decryptability, pass 2 can't strand a
   * half-converted file, and reencryptValue is idempotent so a re-run is safe.
   *
   * @param {string} targetBackend
   * @returns {{ok:boolean, failures:{file:string,reason:string}[]}}
   */
  reencryptAll(targetBackend) {
    const files = this._secretFiles();

    const failures = [];
    for (const f of files) {
      const doc = io.readJSON(f.path);
      if (!doc) continue;
      for (const value of f.collect(doc)) {
        if (!crypto.isEncrypted(value)) continue;
        try {
          crypto.reencryptValue(value, targetBackend); // decrypt-then-seal (discarded)
        } catch (err) {
          failures.push({
            file: f.label,
            reason: (err && err.code) || "error",
          });
        }
      }
    }
    if (failures.length) return { ok: false, failures };

    for (const f of files) {
      const doc = io.readJSON(f.path);
      if (!doc) continue;
      const next = f.transform(doc, (v) =>
        crypto.reencryptValue(v, targetBackend),
      );
      io.writeJSON(f.path, next);
    }
    return { ok: true, failures: [] };
  }

  // ── Mode switch / unlock / lock (the IPC-facing operations) ──────────────────

  /** The renderer-facing state: active mode + session lock + capabilities. */
  getState() {
    const config = this.readConfig();
    return {
      mode: crypto.getMode(),
      locked: crypto.isLocked(),
      available: crypto.isAvailable(), // is the OS keychain usable here?
      hasPassword: Boolean(config && config.verifier),
    };
  }

  /**
   * Switch the at-rest backend, re-encrypting every secret to it. All-or-nothing
   * and crash-safe: prepare the target key material, mark the migration, convert,
   * then flip the mode LAST. A decrypt failure aborts with nothing changed.
   *
   * Never downgrades to plaintext: os-keychain is refused when safeStorage is
   * unavailable, and leaving master-password requires an unlocked session.
   *
   * @param {string} targetMode
   * @param {string} [password]  required when switching TO master-password
   * @returns {{ok:boolean, unchanged?:boolean, reason?:string, failures?:object[]}}
   */
  setMode(targetMode, password) {
    if (!MODES.includes(targetMode))
      return { ok: false, reason: "invalid-mode" };
    const current = crypto.getMode();
    if (targetMode === current) return { ok: true, unchanged: true };

    // Leaving master-password requires an unlocked session to read encm: secrets.
    if (current === "master-password" && crypto.isLocked()) {
      return { ok: false, reason: "locked" };
    }

    // Prepare the TARGET backend's durable key material BEFORE converting.
    let prep = null;
    let markerExtra = {};
    if (targetMode === "app-key") {
      crypto.configure({ appKey: this.ensureAppKey() }); // active mode still `current`
    } else if (targetMode === "os-keychain") {
      if (!crypto.isAvailable())
        return { ok: false, reason: "keychain-unavailable" };
    } else if (targetMode === "master-password") {
      if (typeof password !== "string" || password.length === 0) {
        return { ok: false, reason: "password-required" };
      }
      prep = this.prepareMasterPassword(password);
      markerExtra = { kdf: prep.kdf, verifier: prep.verifier };
    }

    // Durably record the in-flight switch, then load the target key and convert.
    this.markMigration(current, targetMode, markerExtra);
    if (targetMode === "master-password") crypto.setMasterKey(prep.key);

    const result = this.reencryptAll(targetMode);
    if (!result.ok) {
      if (targetMode === "master-password") {
        // Drop the marker AND the kdf/verifier this aborted switch minted (the
        // mode never became master-password), then re-lock the unused session
        // key so it doesn't linger unlocked.
        this._abortMasterPasswordSwitch();
        crypto.lock();
      } else {
        this.clearMigration();
      }
      return {
        ok: false,
        reason: "migration-failed",
        failures: result.failures,
      };
    }

    this._flipMode(targetMode, {
      kdf: prep && prep.kdf,
      verifier: prep && prep.verifier,
      masterKey: prep && prep.key,
    });
    return { ok: true };
  }

  /**
   * Flip the active mode LAST (the atomicity anchor): persist the target config
   * (dropping the marker), reconfigure the live crypto backend, and delete the
   * app-key file when leaving app-key. Shared by setMode + resumeMigration.
   */
  _flipMode(to, { kdf, verifier, masterKey } = {}) {
    if (to === "master-password") {
      this.writeConfig({ mode: to, kdf, verifier });
      crypto.configure({ mode: to, appKey: null, masterKey });
    } else if (to === "app-key") {
      this.writeConfig({ mode: to });
      crypto.configure({
        mode: to,
        appKey: this.readAppKey(),
        masterKey: null,
      });
    } else {
      this.writeConfig({ mode: to });
      crypto.configure({ mode: to, appKey: null, masterKey: null });
    }
    if (to !== "app-key") this.deleteAppKey();
  }

  /**
   * Unlock a locked master-password session for this run. Verifies the password,
   * loads the derived key, and finishes any master-password migration a crash
   * interrupted.
   *
   * @param {string} password
   * @returns {{ok:boolean, reason?:string}}
   */
  unlock(password) {
    const config = this.readConfig();
    const marker = this.pendingMigration();
    const masterMigration = marker && this._markerNeedsPassword(marker);
    if (
      !config ||
      (config.mode !== "master-password" && !masterMigration) ||
      !config.verifier
    ) {
      return { ok: false, reason: "not-applicable" };
    }
    const key = this.verifyMasterPassword(password, config);
    if (!key) return { ok: false, reason: "bad-password" };

    crypto.setMasterKey(key);
    // Finish an interrupted migration to/from master-password (no-op otherwise).
    // The unlock itself has SUCCEEDED — the password verified and the session key
    // is loaded, so source-mode secrets are now readable — but the crash-resumed
    // backend switch can still fail to complete (e.g. the target keystore is
    // unavailable). Surface that instead of swallowing it: the marker stays and
    // the switch retries next launch, but the caller/UI must know the switch is
    // stuck rather than believing the mode change finished.
    const resume = this.resumeMigration({ masterKey: key });
    if (resume.status === "failed") {
      console.error(
        "[secret-storage] unlock succeeded but the pending backend switch could " +
          "not be finished; it will retry next launch.",
      );
      return { ok: true, migrationIncomplete: true, failures: resume.failures };
    }
    return { ok: true };
  }

  /** Drop the in-memory master key (re-lock master-password secrets). */
  lock() {
    crypto.lock();
    return { ok: true };
  }
}

module.exports = { SecretStorage, MODES, DEFAULT_MODE, defaultModeFor };
