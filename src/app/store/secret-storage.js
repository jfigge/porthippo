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
 * mode config file and the app-key file. Ported down from Rest Hippo to the two
 * backends Port Hippo needs (see crypto.js for the ciphertext families):
 *   - "app-key"      a random 256-bit key in a 0600 file. No OS prompt; the
 *                    DEFAULT for a background tunnel manager. enck:v1:
 *   - "os-keychain"  Electron safeStorage (macOS Keychain / Windows DPAPI /
 *                    Linux libsecret). enc:v1:
 *
 * The active mode is recorded in an UNENCRYPTED config file (`secret-storage.json`)
 * read at bootstrap BEFORE any decrypt, so resolving the mode never touches the
 * keystore (and so never triggers a Keychain prompt). If that config is ever lost
 * the mode is inferred from the prefix of existing on-disk ciphertext, so we never
 * mint a fresh app key that orphans already-sealed secrets.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const nodeCrypto = require("crypto");
const io = require("./io");
const crypto = require("./crypto");

const CONFIG_VERSION = 1;
const MODES = ["app-key", "os-keychain"];
const DEFAULT_MODE = "app-key";

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

  // ── Bootstrap (called once at startup, before any decrypt) ──────────────────

  /**
   * Resolve the active mode + key and configure crypto, BEFORE any store reads.
   *
   * On a fresh config (first run, or a lost config file) the mode is INFERRED from
   * existing on-disk ciphertext by prefix — os-keychain (`enc:v1:`) → app-key
   * (`enck:v1:`) → the platform default — and persisted so it never re-scans. The
   * app key is loaded whenever the key file exists (even in os-keychain mode) so a
   * mix of both families stays decryptable; only its absence in app-key mode mints
   * a new one.
   *
   * @returns {{mode:string}}
   */
  bootstrap() {
    let config = this.readConfig();
    if (!config) config = this._inferAndPersist();

    const mode = config.mode;
    let appKey = mode === "app-key" ? this.ensureAppKey() : this.readAppKey();
    if (appKey === null && mode === "app-key") appKey = this.ensureAppKey();

    crypto.configure({ mode, appKey });
    return { mode };
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
   */
  _inferMode() {
    if (this._anySealedSecret((v) => v.startsWith(crypto.PREFIX))) {
      return "os-keychain";
    }
    if (this._anySealedSecret((v) => v.startsWith(crypto.PREFIX_APPKEY))) {
      return "app-key";
    }
    return defaultModeFor(process.platform, crypto.isAvailable());
  }

  /**
   * Whether ANY sealed secret in tunnels.json satisfies `isHit`. tunnels.json is
   * the only secret-bearing file in Feature 10; secrets live at
   * `sshServer.auth[].{password,passphrase}.enc` and the same under each
   * `jumps[].auth[]`. Pure string-prefix work — never decrypts.
   *
   * @param {(value: string) => boolean} isHit
   */
  _anySealedSecret(isHit) {
    const doc = io.readJSON(this._paths.tunnelsPath());
    const tunnels = Array.isArray(doc?.tunnels) ? doc.tunnels : [];
    for (const t of tunnels) {
      if (!t || typeof t !== "object") continue;
      const hops = [t.sshServer, ...(Array.isArray(t.jumps) ? t.jumps : [])];
      for (const hop of hops) {
        for (const entry of Array.isArray(hop?.auth) ? hop.auth : []) {
          if (!entry || typeof entry !== "object") continue;
          for (const field of ["password", "passphrase"]) {
            const enc = entry[field]?.enc;
            if (typeof enc === "string" && isHit(enc)) return true;
          }
        }
      }
    }
    return false;
  }
}

module.exports = { SecretStorage, MODES, DEFAULT_MODE, defaultModeFor };
