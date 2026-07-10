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
 * stores.js — Factory that wires the main-process stores together over a single
 * data directory.
 *
 * Construction order matters: the secret-storage backend is resolved and crypto
 * is configured BEFORE any store is built, so the first decrypt has the active
 * mode + key in place (and resolving the mode never touches the keystore, so it
 * can't trigger an OS prompt). Then a startup sweep reclaims any temp files left
 * by a crashed write.
 *
 *   const { Stores } = require("./store/stores");
 *   const stores = new Stores(app.getPath("userData"));
 *   stores.tunnelStore().list();
 */
"use strict";

const io = require("./io");
const { Paths } = require("./paths");
const { SecretStorage } = require("./secret-storage");
const { TunnelStore } = require("./tunnel-store");
const { CredentialStore } = require("./credential-store");
const { JumpHostStore } = require("./jump-host-store");
const { KnownHostsStore } = require("./known-hosts-store");
const { SettingsStore } = require("./settings-store");

class Stores {
  /**
   * @param {string} dataDir  Root data directory (e.g. app.getPath("userData")).
   */
  constructor(dataDir) {
    this._paths = new Paths(dataDir);

    // Resolve the secret-storage backend + configure crypto before any store read.
    this._secretStorage = new SecretStorage(this._paths);
    this._secretStorage.bootstrap();

    // Reclaim orphaned temp files from any prior crashed write.
    io.gcOrphanTempFiles(this._paths.dataDir);

    this._tunnelStore = new TunnelStore(this._paths);
    this._credentialStore = new CredentialStore(this._paths);
    this._jumpHostStore = new JumpHostStore(this._paths);
    this._knownHostsStore = new KnownHostsStore(this._paths);
    this._settingsStore = new SettingsStore(this._paths);
  }

  /** Ordered collection of tunnel definitions (reference records, no secrets). */
  tunnelStore() {
    return this._tunnelStore;
  }

  /** Reusable, named SSH credentials (secrets sealed at rest). */
  credentialStore() {
    return this._credentialStore;
  }

  /** Reusable, named SSH jump hosts (each references a credential). */
  jumpHostStore() {
    return this._jumpHostStore;
  }

  /** Port-Hippo-accepted SSH host-key fingerprints (TOFU). */
  knownHostsStore() {
    return this._knownHostsStore;
  }

  /** App-wide preferences. */
  settingsStore() {
    return this._settingsStore;
  }

  /** The resolved secret-storage backend (mode config + app key). */
  secretStorage() {
    return this._secretStorage;
  }

  /** Shared Paths instance — the single source of truth for filesystem paths. */
  paths() {
    return this._paths;
  }
}

module.exports = { Stores };
