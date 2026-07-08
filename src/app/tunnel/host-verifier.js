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
 * host-verifier.js — SSH host-key verification for each hop of a chain.
 *
 * `makeHostVerifier(opts)` returns the function ssh2 calls with the presented host
 * key (a raw wire-format Buffer). It accepts the key iff its SHA-256 fingerprint
 * matches either (a) the user's `~/.ssh/known_hosts` or (b) Port Hippo's own
 * accepted-keys store (`KnownHostsStore`, trust-on-first-use). The precedence:
 *
 *   - match found            → accept.
 *   - a key of the same type is on record but differs → HARD REJECT (possible
 *     MITM); report `changed` so the renderer can warn. Never auto-accept.
 *   - no key on record at all → hold the connection pending, ask the user to trust
 *     (TOFU); accept only if they do, and persist the trust via `KnownHostsStore`.
 *
 * Only fingerprints (`SHA256:…`) ever leave this module — never key material.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Default location of the user's OpenSSH known_hosts file. */
function defaultKnownHostsPath() {
  return path.join(os.homedir(), ".ssh", "known_hosts");
}

/** OpenSSH-style `SHA256:<base64-no-padding>` fingerprint of a host-key blob. */
function sha256Fingerprint(keyBlob) {
  const digest = crypto.createHash("sha256").update(keyBlob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** The algorithm name embedded at the front of an SSH key blob (e.g. ssh-ed25519). */
function keyAlgorithm(keyBlob) {
  const len = keyBlob.readUInt32BE(0);
  return keyBlob.subarray(4, 4 + len).toString("ascii");
}

/**
 * Parse known_hosts text into structured entries. Each entry keeps its raw host
 * patterns (plain, `[host]:port`, wildcards, or a hashed `|1|salt|hash`), the key
 * type, and the decoded key blob for direct comparison.
 * @param {string} content
 * @returns {Array<{marker: string|null, hostPatterns: string[], keyType: string, keyBlob: Buffer}>}
 */
function parseKnownHosts(content) {
  const entries = [];
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    let rest = line;
    let marker = null;
    if (rest.startsWith("@")) {
      const sp = rest.indexOf(" ");
      if (sp === -1) continue;
      marker = rest.slice(1, sp);
      rest = rest.slice(sp + 1).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) continue;
    const [hostField, keyType, keyBase64] = parts;

    let keyBlob;
    try {
      keyBlob = Buffer.from(keyBase64, "base64");
    } catch {
      continue;
    }
    if (keyBlob.length === 0) continue;

    entries.push({
      marker,
      hostPatterns: hostField.split(","),
      keyType,
      keyBlob,
    });
  }
  return entries;
}

/** Convert an OpenSSH host glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withGlobs = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${withGlobs}$`);
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Match one hashed (`|1|salt|hash`) host pattern against a lookup name. */
function hashedMatch(pattern, name) {
  const parts = pattern.split("|");
  // ["", "1", "<base64 salt>", "<base64 hash>"]
  if (parts.length !== 4 || parts[1] !== "1") return false;
  let salt;
  try {
    salt = Buffer.from(parts[2], "base64");
  } catch {
    return false;
  }
  const mac = crypto.createHmac("sha1", salt).update(name).digest("base64");
  return constantTimeEqual(mac, parts[3]);
}

/**
 * Does a comma-separated host-pattern list apply to `name`? Honors `*`/`?`
 * wildcards, `!` negation, and hashed entries. A negated match vetoes the line.
 */
function matchHostList(patterns, name) {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("|1|")) {
      if (hashedMatch(pattern, name)) matched = true;
      continue;
    }
    const negated = pattern.startsWith("!");
    const bare = negated ? pattern.slice(1) : pattern;
    if (globToRegExp(bare).test(name)) {
      if (negated) return false; // an explicit negation vetoes the whole line
      matched = true;
    }
  }
  return matched;
}

/** The name OpenSSH looks a host up under: `host` for port 22, else `[host]:port`. */
function lookupName(host, port) {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Load + parse known_hosts, tolerating an absent/unreadable file. */
function loadKnownHosts(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return parseKnownHosts(content);
}

/**
 * Build the ssh2 `hostVerifier` for one hop.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} opts.hopLabel        e.g. "sshServer" or "jump[0]"
 * @param {string} opts.tunnelId
 * @param {import('../store/known-hosts-store').KnownHostsStore} opts.knownHostsStore
 * @param {string} [opts.knownHostsFile]  override the OpenSSH known_hosts path (tests)
 * @param {(info: object) => Promise<boolean>} opts.requestTrust  resolve a TOFU prompt
 * @param {(info: object) => void} [opts.reportChanged]  a changed/MITM key was seen
 * @returns {(key: Buffer, verify: (ok: boolean) => void) => void}
 */
function makeHostVerifier(opts) {
  const {
    host,
    port,
    hopLabel,
    tunnelId,
    knownHostsStore,
    knownHostsFile,
    requestTrust,
    reportChanged,
  } = opts;
  const hostPort = `${host}:${port}`;
  const file = knownHostsFile || defaultKnownHostsPath();

  // Note: returns undefined on every path and calls verify() exactly once, so ssh2
  // waits for our (possibly async, user-gated) decision rather than a return value.
  return (key, verify) => {
    let fingerprint;
    let presentedAlgo;
    try {
      fingerprint = sha256Fingerprint(key);
      presentedAlgo = keyAlgorithm(key);
    } catch {
      verify(false);
      return;
    }

    // (a) Port Hippo's own accepted-keys store (TOFU).
    let tofu = null;
    try {
      tofu = knownHostsStore.get(hostPort);
    } catch {
      tofu = null;
    }
    if (tofu && tofu.fingerprint === fingerprint) {
      verify(true);
      return;
    }

    // (b) The user's ~/.ssh/known_hosts, matched by host + key type.
    const name = lookupName(host, port);
    const matching = loadKnownHosts(file).filter(
      (e) => e.marker !== "revoked" && matchHostList(e.hostPatterns, name),
    );
    if (matching.some((e) => e.keyBlob.equals(key))) {
      verify(true);
      return;
    }

    const sameTypeOnRecord = matching.some((e) => e.keyType === presentedAlgo);
    if (sameTypeOnRecord || tofu) {
      // A key of this type is already on record but does not match — never
      // silently accept a changed key; treat as a possible MITM.
      reportChanged?.({ tunnelId, hop: hopLabel, host, port, fingerprint });
      verify(false);
      return;
    }

    // (c) Unknown host key — hold pending until the user trusts or rejects.
    Promise.resolve(
      requestTrust({
        tunnelId,
        hop: hopLabel,
        host,
        port,
        hostPort,
        fingerprint,
      }),
    )
      .then((accepted) => {
        if (accepted) {
          try {
            knownHostsStore.trust(hostPort, fingerprint);
          } catch {
            // Persisting the trust is best-effort; the connection may still proceed.
          }
          verify(true);
        } else {
          verify(false);
        }
      })
      .catch(() => verify(false));
  };
}

module.exports = {
  makeHostVerifier,
  parseKnownHosts,
  matchHostList,
  sha256Fingerprint,
  defaultKnownHostsPath,
};
