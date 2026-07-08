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
 * tunnel-store.js — Durable, ordered collection of tunnel definitions.
 *
 * One JSON document (`tunnels.json` = `{ schemaVersion, tunnels: [...] }`) holds
 * every definition in display order (array position IS the order — the `order`
 * field on a returned view is derived from the index, so it can never drift). All
 * mutations read-modify-write the whole file through io.js's atomic, synchronous
 * writes (which serialize by virtue of being synchronous).
 *
 * Secrets are write-only across the IPC boundary. On disk a hop's auth secret
 * lives at `auth[i].{password|passphrase}` as `{ enc: "<ciphertext>" }` (sealed by
 * crypto.js). There are three read shapes:
 *   - list() / get()        renderer-facing: secret objects are stripped and
 *                           replaced with a `hasSecret` boolean — the plaintext
 *                           never crosses IPC.
 *   - listDecrypted() / getDecrypted()  in-process (the Feature 20 engine): secret
 *                           objects are decrypted back to plaintext strings.
 *
 * On write the renderer sends a NEW secret as a plaintext string (encrypted here)
 * or, to keep an existing secret it never received, sends the auth entry back with
 * `hasSecret: true` and no value (the on-disk ciphertext is retained). Sending
 * `hasSecret: false` / omitting it clears the secret. This is what lets an edit
 * that never touches a password avoid clobbering it.
 */
"use strict";

const io = require("./io");
const crypto = require("./crypto");
const { validateDefinition, secretFieldForAuthType } = require("./validate");

/** Auth secret field names — the union of every secretFieldForAuthType result. */
const SECRET_FIELDS = ["password", "passphrase"];

/** True when `v` is a sealed secret object `{ enc: "<ciphertext>" }`. */
function isSealed(v) {
  return Boolean(v) && typeof v === "object" && typeof v.enc === "string";
}

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidDefinitionError(errors) {
  const err = new Error("invalid tunnel definition");
  err.code = "INVALID_DEFINITION";
  err.errors = errors;
  return err;
}

// ── Secret transforms over a single auth entry ─────────────────────────────────

/**
 * Produce the on-disk form of an incoming auth entry, sealing its secret.
 * `existing` is the positionally-matched prior on-disk entry (or undefined),
 * consulted only to retain a secret the caller asked to keep.
 */
function sealAuthEntry(incoming, existing) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const out = { ...incoming };
  delete out.hasSecret; // a read-side marker; never persisted
  delete out.decryptError; // a read-side marker; never persisted

  const field = secretFieldForAuthType(incoming.type);
  // Drop any secret field that doesn't belong to this auth type (e.g. a stray
  // password on a `key` entry) so a type switch can't leave an orphan secret.
  for (const f of SECRET_FIELDS) {
    if (f !== field) delete out[f];
  }
  if (!field) return out;

  const val = incoming[field];
  if (typeof val === "string" && val.length > 0) {
    out[field] = { enc: crypto.encryptString(val) }; // new secret → seal it
  } else if (isSealed(val)) {
    out[field] = val; // already sealed (idempotent re-write)
  } else if (incoming.hasSecret === true && isSealed(existing?.[field])) {
    out[field] = existing[field]; // keep the existing on-disk ciphertext
  } else {
    delete out[field]; // no secret / cleared
  }
  return out;
}

/** Renderer-facing form: strip the secret, expose only whether one exists. */
function stripAuthEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  const field = secretFieldForAuthType(entry.type);
  for (const f of SECRET_FIELDS) delete out[f];
  delete out.decryptError;
  if (field) out.hasSecret = isSealed(entry[field]);
  return out;
}

/** In-process (engine) form: decrypt the secret back to a plaintext string. */
function decryptAuthEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  const field = secretFieldForAuthType(entry.type);
  if (field && isSealed(entry[field])) {
    try {
      out[field] = crypto.decryptString(entry[field].enc);
    } catch (err) {
      if (!(err instanceof crypto.DecryptError)) throw err;
      // A secret that can't be decrypted (keystore unavailable, rotated key) is
      // blanked and flagged rather than surfaced as stale ciphertext; the engine
      // treats a flagged entry as "no usable secret" and moves to the next method.
      out[field] = "";
      out.decryptError = err.code;
    }
  }
  return out;
}

// ── Secret transforms over a whole definition ──────────────────────────────────

function mapHopAuth(hop, fn) {
  if (!hop || typeof hop !== "object" || !Array.isArray(hop.auth)) {
    return hop && typeof hop === "object" ? { ...hop } : hop;
  }
  return { ...hop, auth: hop.auth.map(fn) };
}

function sealHop(incomingHop, existingHop) {
  if (!incomingHop || typeof incomingHop !== "object") return incomingHop;
  if (!Array.isArray(incomingHop.auth)) return { ...incomingHop };
  const existingAuth = Array.isArray(existingHop?.auth) ? existingHop.auth : [];
  return {
    ...incomingHop,
    auth: incomingHop.auth.map((entry, i) =>
      sealAuthEntry(entry, existingAuth[i]),
    ),
  };
}

/** Seal every secret in a definition, retaining kept secrets from `existing`. */
function sealDefinition(incoming, existing) {
  const out = { ...incoming };
  out.sshServer = sealHop(incoming.sshServer, existing?.sshServer);
  if (Array.isArray(incoming.jumps)) {
    const existingJumps = Array.isArray(existing?.jumps) ? existing.jumps : [];
    out.jumps = incoming.jumps.map((hop, i) => sealHop(hop, existingJumps[i]));
  }
  return out;
}

function transformDefinition(def, fn) {
  const out = { ...def };
  out.sshServer = mapHopAuth(def.sshServer, fn);
  if (Array.isArray(def.jumps)) {
    out.jumps = def.jumps.map((hop) => mapHopAuth(hop, fn));
  }
  return out;
}

const stripDefinition = (def) => transformDefinition(def, stripAuthEntry);
const decryptDefinition = (def) => transformDefinition(def, decryptAuthEntry);

/** Apply store-level defaults to an incoming definition (post-validation). */
function applyDefaults(def) {
  return {
    ...def,
    enabled: def.enabled ?? true,
    bindHost: def.bindHost ?? "127.0.0.1",
    keepAlive: def.keepAlive ?? false,
    autoReconnect: def.autoReconnect ?? false,
    jumps: Array.isArray(def.jumps) ? def.jumps : [],
  };
}

class TunnelStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  /** Raw sealed definitions in stored (display) order. */
  _readAll() {
    const doc = io.readJSON(this._paths.tunnelsPath());
    return Array.isArray(doc?.tunnels) ? doc.tunnels : [];
  }

  _writeAll(tunnels) {
    io.writeJSON(this._paths.tunnelsPath(), { tunnels });
  }

  // ── Renderer-facing reads (secrets stripped to hasSecret) ────────────────────

  /** Every definition, in order, secrets stripped. */
  list() {
    return this._readAll().map((def, i) =>
      stripDefinition({ ...def, order: i }),
    );
  }

  /** One definition by id, secrets stripped, or null if absent. */
  get(id) {
    const list = this._readAll();
    const i = list.findIndex((d) => d && d.id === id);
    return i === -1 ? null : stripDefinition({ ...list[i], order: i });
  }

  // ── In-process reads (secrets decrypted — engine only, never over IPC) ───────

  /** Every definition, in order, secrets decrypted to plaintext. */
  listDecrypted() {
    return this._readAll().map((def, i) =>
      decryptDefinition({ ...def, order: i }),
    );
  }

  /** One definition by id, secrets decrypted, or null if absent. */
  getDecrypted(id) {
    const list = this._readAll();
    const i = list.findIndex((d) => d && d.id === id);
    return i === -1 ? null : decryptDefinition({ ...list[i], order: i });
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Create a new definition (plaintext secrets are sealed on write). Returns the
   * renderer-facing view of the created record. Throws INVALID_DEFINITION (with a
   * field-keyed `.errors`) on a bad definition.
   */
  create(def) {
    const { valid, errors } = validateDefinition(def);
    if (!valid) throw invalidDefinitionError(errors);

    const list = this._readAll();
    const sealed = sealDefinition(applyDefaults(def), null);
    sealed.id = io.newUUID();
    delete sealed.order; // order is derived from array position, never stored
    list.push(sealed);
    this._writeAll(list);
    return stripDefinition({ ...sealed, order: list.length - 1 });
  }

  /**
   * Patch an existing definition. The patch shallow-overrides top-level fields
   * (a provided `sshServer` / `jumps` replaces the old one wholesale). Secrets in
   * the merged result are sealed, retaining kept secrets from the prior record.
   * Throws NOT_FOUND for an unknown id, INVALID_DEFINITION on a bad merged result.
   */
  update(id, patch) {
    const list = this._readAll();
    const i = list.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`tunnel not found: ${id}`);

    const existing = list[i];
    const merged = applyDefaults({ ...existing, ...patch, id });
    const { valid, errors } = validateDefinition(merged);
    if (!valid) throw invalidDefinitionError(errors);

    const sealed = sealDefinition(merged, existing);
    sealed.id = id;
    delete sealed.order;
    list[i] = sealed;
    this._writeAll(list);
    return stripDefinition({ ...sealed, order: i });
  }

  /** Remove a definition. Throws NOT_FOUND for an unknown id. */
  delete(id) {
    const list = this._readAll();
    const i = list.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`tunnel not found: ${id}`);
    list.splice(i, 1);
    this._writeAll(list);
    return { id };
  }

  /**
   * Reorder definitions to match `ids`. Ids not present are ignored; any existing
   * definition missing from `ids` is appended after the listed ones in its current
   * order, so a stale/partial list can never drop a tunnel. Returns the new
   * renderer-facing list.
   */
  reorder(ids) {
    const list = this._readAll();
    const order = Array.isArray(ids) ? ids : [];
    const byId = new Map(list.map((d) => [d && d.id, d]));

    const next = [];
    const placed = new Set();
    for (const id of order) {
      const def = byId.get(id);
      if (def && !placed.has(id)) {
        next.push(def);
        placed.add(id);
      }
    }
    for (const def of list) {
      if (def && !placed.has(def.id)) next.push(def);
    }

    this._writeAll(next);
    return next.map((def, i) => stripDefinition({ ...def, order: i }));
  }
}

module.exports = { TunnelStore };
