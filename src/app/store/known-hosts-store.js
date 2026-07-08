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
 * known-hosts-store.js — SSH host-key fingerprints the user has accepted through
 * Port Hippo (trust-on-first-use). Consumed by the Feature 20 host-key verifier.
 *
 * Kept deliberately separate from `~/.ssh/known_hosts` (which the engine also
 * reads): this file holds only the TOFU entries a user explicitly accepted in
 * Port Hippo, keyed by `"<host>:<port>"`. Persisted as
 * `{ schemaVersion, hosts: { "<hostPort>": { fingerprint, addedAt } } }`.
 */
"use strict";

const io = require("./io");

function requireHostPort(hostPort) {
  if (typeof hostPort !== "string" || hostPort.length === 0) {
    const err = new Error("hostPort must be a non-empty string");
    err.code = "INVALID_ARG";
    throw err;
  }
}

class KnownHostsStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    const doc = io.readJSON(this._paths.knownHostsPath());
    return doc && typeof doc.hosts === "object" && doc.hosts !== null
      ? doc.hosts
      : {};
  }

  _write(hosts) {
    io.writeJSON(this._paths.knownHostsPath(), { hosts });
  }

  /** The accepted entry for `hostPort` (`{ fingerprint, addedAt }`), or null. */
  get(hostPort) {
    requireHostPort(hostPort);
    return this._read()[hostPort] ?? null;
  }

  /**
   * Record (or replace) an accepted fingerprint for `hostPort`.
   * @param {string} hostPort  e.g. "bastion.example.com:22"
   * @param {string} fingerprint  the accepted host-key fingerprint
   * @returns {{ hostPort: string, fingerprint: string, addedAt: number }}
   */
  trust(hostPort, fingerprint) {
    requireHostPort(hostPort);
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      const err = new Error("fingerprint must be a non-empty string");
      err.code = "INVALID_ARG";
      throw err;
    }
    const hosts = this._read();
    const entry = { fingerprint, addedAt: Date.now() };
    hosts[hostPort] = entry;
    this._write(hosts);
    return { hostPort, ...entry };
  }

  /** All accepted host keys as `[{ hostPort, fingerprint, addedAt }]`. */
  list() {
    const hosts = this._read();
    return Object.entries(hosts).map(([hostPort, entry]) => ({
      hostPort,
      ...entry,
    }));
  }

  /**
   * Forget an accepted host key. Idempotent — revoking an absent entry is a no-op.
   * @param {string} hostPort
   * @returns {{ hostPort: string, revoked: boolean }}
   */
  revoke(hostPort) {
    requireHostPort(hostPort);
    const hosts = this._read();
    const revoked = Object.prototype.hasOwnProperty.call(hosts, hostPort);
    if (revoked) {
      delete hosts[hostPort];
      this._write(hosts);
    }
    return { hostPort, revoked };
  }
}

module.exports = { KnownHostsStore };
