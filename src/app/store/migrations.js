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
 * migrations.js — Schema versioning & forward migration for stored documents.
 *
 * Every stored document (tunnels.json, settings.json, known-hosts.json, …)
 * carries a top-level integer `schemaVersion`. Documents written before this
 * field existed are treated as version `BASE_SCHEMA_VERSION` (1). `MIGRATIONS` is
 * an ordered list of pure, synchronous transforms; entry `i` upgrades a document
 * from version `i + BASE_SCHEMA_VERSION` to the next version.
 *
 * `migrate(doc)` runs every migration newer than the document's own version, then
 * stamps `CURRENT_SCHEMA_VERSION`. It is applied on the read path so in-memory
 * documents are always current; the upgraded shape is persisted lazily on the
 * next normal save (we do NOT eagerly rewrite files on load).
 *
 * Feature 10 ships schema v1; Feature 45 adds the v1→v2 transform that lifts each
 * tunnel's embedded auth into reusable `credentials[]` and its inline jump hosts
 * into reusable `jumpHosts[]`, rewriting the tunnel to reference them by id.
 * Feature 110 adds the v2→v3 transform that stamps a forwarding `type: "local"` on
 * every existing tunnel so reverse / dynamic types can be authored alongside them.
 * Feature 140 adds the v3→v4 transform that adds an empty `groups: []` sibling
 * array (leaving every tunnel ungrouped) so reusable tunnel groups can be authored.
 *
 * Rules for migration functions:
 *   - Pure and synchronous — no I/O, no mutation of the input (return a new object).
 *   - Each bumps the schema by exactly one version; `migrate` handles stamping.
 *   - Type-guarded and idempotent: `migrate()` runs on EVERY stored document (and
 *     on every write, before the version stamp), so a transform must inspect a
 *     discriminating field, pass unrelated shapes through untouched, and be a
 *     no-op when applied to an already-migrated document.
 */
"use strict";

/** The version assumed for any document lacking a valid `schemaVersion`. */
const BASE_SCHEMA_VERSION = 1;

const AUTH_TYPES = ["agent", "key", "password"];
const DEFAULT_SSH_PORT = 22;

/**
 * Extract the single primary auth method + user of an old-shape hop into a
 * credential body `{ user, authType, keyPath?, <sealed secret> }`. Only `auth[0]`
 * (the highest-priority method) is carried — Feature 45 credentials hold one
 * method — so a hop that listed several methods keeps its first. Sealed secret
 * objects (`{ enc }`) are relocated verbatim, never decrypted.
 */
function credentialFromHop(hop) {
  const h = hop && typeof hop === "object" ? hop : {};
  const entry = (Array.isArray(h.auth) ? h.auth : [])[0] || { type: "agent" };
  const authType = AUTH_TYPES.includes(entry.type) ? entry.type : "agent";
  const cred = { user: typeof h.user === "string" ? h.user : "", authType };
  if (authType === "key") {
    if (typeof entry.privateKeyPath === "string")
      cred.keyPath = entry.privateKeyPath;
    if (entry.passphrase !== undefined) cred.passphrase = entry.passphrase;
  } else if (authType === "password") {
    if (entry.password !== undefined) cred.password = entry.password;
  }
  return cred;
}

/** Dedupe key over a credential's CONTENT (never its id/label). */
function credentialKey(c) {
  return JSON.stringify({
    user: c.user ?? "",
    authType: c.authType,
    keyPath: c.keyPath,
    password: c.password,
    passphrase: c.passphrase,
  });
}

/** Dedupe key over a jump host's endpoint + credential. */
function jumpKey(j) {
  return JSON.stringify({
    host: j.host,
    port: j.port,
    credentialId: j.credentialId,
  });
}

/**
 * v1 → v2: promote embedded auth / inline jump hosts to reusable, referenced
 * records. Type-guarded to the tunnels document and idempotent (a tunnel already
 * in reference shape has no `sshServer`, so it is passed through untouched).
 */
function extractCredentialsAndJumpHosts(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.tunnels)) {
    return doc; // not the tunnels document — nothing to do
  }

  const embedded = doc.tunnels.some((t) => t && t.sshServer);
  if (!embedded) {
    // Already reference-shaped: just guarantee the sibling arrays exist.
    if (Array.isArray(doc.credentials) && Array.isArray(doc.jumpHosts)) {
      return doc;
    }
    return {
      ...doc,
      credentials: Array.isArray(doc.credentials) ? doc.credentials : [],
      jumpHosts: Array.isArray(doc.jumpHosts) ? doc.jumpHosts : [],
    };
  }

  const credentials = Array.isArray(doc.credentials)
    ? [...doc.credentials]
    : [];
  const jumpHosts = Array.isArray(doc.jumpHosts) ? [...doc.jumpHosts] : [];
  const credByKey = new Map();
  const jumpByKey = new Map();
  for (const c of credentials)
    if (c && c.id) credByKey.set(credentialKey(c), c.id);
  for (const j of jumpHosts) if (j && j.id) jumpByKey.set(jumpKey(j), j.id);
  let credSeq = credentials.length;
  let jumpSeq = jumpHosts.length;

  const internCredential = (hop) => {
    const body = credentialFromHop(hop);
    const key = credentialKey(body);
    if (credByKey.has(key)) return credByKey.get(key);
    const id = `cred-${credSeq++}`;
    credentials.push({ id, label: body.user || "credential", ...body });
    credByKey.set(key, id);
    return id;
  };

  const internJumpHost = (hop) => {
    const h = hop && typeof hop === "object" ? hop : {};
    const credentialId = internCredential(h);
    const jh = {
      label: (typeof h.host === "string" && h.host) || "jump host",
      host: typeof h.host === "string" ? h.host : "",
      port: Number.isInteger(h.port) ? h.port : DEFAULT_SSH_PORT,
      credentialId,
    };
    const key = jumpKey(jh);
    if (jumpByKey.has(key)) return jumpByKey.get(key);
    const id = `jump-${jumpSeq++}`;
    jumpHosts.push({ id, ...jh });
    jumpByKey.set(key, id);
    return id;
  };

  const tunnels = doc.tunnels.map((t) => {
    if (!t || typeof t !== "object" || !t.sshServer) return t;
    const server = t.sshServer;
    const out = {
      id: t.id,
      name: t.name,
      localPort: t.localPort,
      destination: t.destination,
      // Behaviour-preserving: the old relay forwarded to destHost:destPort AS THE
      // SSH SERVER RESOLVED IT, which is exactly what a NON-BLANK sshHost means in
      // v2. So set sshHost explicitly (never blank) even when the server was the
      // destination box — blank is reserved for newly-authored v2 tunnels.
      sshHost: server.host,
      sshPort: Number.isInteger(server.port) ? server.port : DEFAULT_SSH_PORT,
      credentialId: internCredential(server),
      jumpHostIds: (Array.isArray(t.jumps) ? t.jumps : []).map(internJumpHost),
      enabled: t.enabled,
      keepAlive: t.keepAlive,
      autoReconnect: t.autoReconnect,
    };
    if (t.bindHost !== undefined) out.bindHost = t.bindHost;
    if (t.lingerMs !== undefined) out.lingerMs = t.lingerMs;
    return out;
  });

  return { ...doc, tunnels, credentials, jumpHosts };
}

/**
 * v2 → v3: stamp a forwarding `type` on every tunnel (Feature 110). Pre-Feature-110
 * tunnels are all local forwards, so a tunnel lacking a `type` becomes `"local"`.
 * Type-guarded to the tunnels document and idempotent (a tunnel that already has a
 * `type` — a freshly authored v3 remote/dynamic tunnel — is passed through).
 */
function stampTunnelType(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.tunnels)) {
    return doc; // not the tunnels document — nothing to do
  }
  const needs = doc.tunnels.some(
    (t) => t && typeof t === "object" && t.type === undefined,
  );
  if (!needs) return doc;
  const tunnels = doc.tunnels.map((t) => {
    if (!t || typeof t !== "object" || t.type !== undefined) return t;
    return { ...t, type: "local" };
  });
  return { ...doc, tunnels };
}

/**
 * v3 → v4: add the reusable `groups` sibling array (Feature 140). Groups are
 * purely organisational; existing tunnels stay ungrouped (no `groupId`).
 * Type-guarded to the tunnels document and idempotent (a doc that already has a
 * `groups` array is passed through untouched).
 */
function addGroupsArray(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.tunnels)) {
    return doc; // not the tunnels document — nothing to do
  }
  if (Array.isArray(doc.groups)) return doc; // already migrated
  return { ...doc, groups: [] };
}

/**
 * Ordered migration functions. `MIGRATIONS[i]` upgrades a document from
 * version `i + BASE_SCHEMA_VERSION` to version `i + BASE_SCHEMA_VERSION + 1`.
 * Each is a pure `(doc) => doc` transform — no I/O, no input mutation.
 *
 * @type {Array<(doc: object) => object>}
 */
const MIGRATIONS = [
  extractCredentialsAndJumpHosts,
  stampTunnelType,
  addGroupsArray,
];

/** The version every freshly written / migrated document is stamped with. */
const CURRENT_SCHEMA_VERSION = BASE_SCHEMA_VERSION + MIGRATIONS.length;

/**
 * Read a document's schema version, defaulting to `BASE_SCHEMA_VERSION` when the
 * field is absent or not a valid version integer.
 *
 * @param {*} doc
 * @returns {number}
 */
function schemaVersionOf(doc) {
  const v = doc && doc.schemaVersion;
  return Number.isInteger(v) && v >= BASE_SCHEMA_VERSION
    ? v
    : BASE_SCHEMA_VERSION;
}

/**
 * Upgrade a document to `CURRENT_SCHEMA_VERSION`, running every migration newer
 * than its current version, then stamping the current version.
 *
 * Non-object inputs (including `null`, e.g. a missing file) are returned as-is so
 * callers' missing-file defaults are unaffected. Documents already at the current
 * version with the field present are returned unchanged.
 *
 * @param {*} doc
 * @returns {*}
 */
function migrate(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return doc;
  }

  // Compute the target from MIGRATIONS.length rather than the cached constant so
  // production stays correct (empty list → target 1) while tests can append
  // migrations to exercise the forward chain.
  const target = BASE_SCHEMA_VERSION + MIGRATIONS.length;
  let version = schemaVersionOf(doc);

  if (version >= target) {
    // Already current: only allocate a copy if the field needs stamping.
    return doc.schemaVersion === version
      ? doc
      : { ...doc, schemaVersion: version };
  }

  let out = doc;
  for (let i = version - BASE_SCHEMA_VERSION; i < MIGRATIONS.length; i++) {
    out = MIGRATIONS[i](out);
    version += 1;
  }
  return { ...out, schemaVersion: target };
}

module.exports = {
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  MIGRATIONS,
  schemaVersionOf,
  migrate,
};
