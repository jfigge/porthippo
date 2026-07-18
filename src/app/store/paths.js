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
 * paths.js — Single source of truth for every filesystem path in the storage
 * layer.
 *
 * Layout (rooted at `dataDir`, Electron's userData dir or a custom --user-data-dir):
 *
 *   tunnels.json           ← ordered list of tunnel definitions (secrets sealed)
 *   settings.json          ← app-wide preferences (theme, defaults, launch-at-login)
 *   known-hosts.json       ← Jump-Hippo-accepted SSH host-key fingerprints (TOFU)
 *   secret-storage.json    ← UNENCRYPTED secret-storage mode config (read pre-decrypt)
 *   secret.key             ← 0600 random app key for "app-key" storage mode
 *   key-bookmarks.json     ← MACHINE-LOCAL security-scoped bookmarks for picked
 *                            private keys (MAS only, Feature 190; never exported)
 */
"use strict";

const path = require("path");

class Paths {
  /**
   * @param {string} dataDir  Root data directory (platform userData dir or custom).
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
  }

  /** Ordered list of tunnel definitions (secret fields sealed at rest). */
  tunnelsPath() {
    return path.join(this.dataDir, "tunnels.json");
  }

  /** App-wide preferences. */
  settingsPath() {
    return path.join(this.dataDir, "settings.json");
  }

  /** Jump-Hippo-accepted SSH host-key fingerprints (trust-on-first-use). */
  knownHostsPath() {
    return path.join(this.dataDir, "known-hosts.json");
  }

  /**
   * Secret-storage mode config (UNENCRYPTED — read at bootstrap before any
   * decrypt, so it must never depend on the keystore). Records the active mode
   * plus, for master-password mode, the PBKDF2 `kdf` (salt + iterations) and the
   * `verifier` blob, and any in-flight `migration` marker (Feature 90). No secret
   * or key material is stored here — the derived key lives in memory only.
   */
  secretStorageConfigPath() {
    return path.join(this.dataDir, "secret-storage.json");
  }

  /** App-key file (0600): the random 256-bit key for "app-key" storage mode. */
  secretKeyPath() {
    return path.join(this.dataDir, "secret.key");
  }

  /**
   * Security-scoped bookmarks for user-picked private-key files (Feature 190,
   * MAS only). MACHINE-LOCAL OS access tokens keyed by absolute path — never a
   * secret value, never exported (kept out of the `.jumphippo` bundle) and never
   * logged.
   */
  keyBookmarksPath() {
    return path.join(this.dataDir, "key-bookmarks.json");
  }

  /** Directory holding the rotating application log files (Feature 60). */
  logsDir() {
    return path.join(this.dataDir, "logs");
  }
}

module.exports = { Paths };
