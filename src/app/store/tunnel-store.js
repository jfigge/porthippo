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
 * Since Feature 45 a tunnel is a REFERENCE record: it holds a `credentialId` (its
 * SSH server's credential) and an ordered list of `jumpHostIds`, and carries no
 * secret of its own — secrets live only in the credential store. Tunnels,
 * credentials and jump hosts share one JSON document (definitions-doc.js); array
 * position IS display order (the `order` field on a returned view is derived from
 * the index, so it can never drift). All mutations read-modify-write the whole
 * document through io.js's atomic, synchronous writes.
 *
 * Two read shapes:
 *   - list() / get()        renderer-facing: the stored reference record plus a
 *                           derived `order` and `routeSummary` (built by the
 *                           resolver so display and behaviour can't drift). No
 *                           secrets exist on a tunnel record to strip.
 *   - listDecrypted() / getDecrypted()  in-process (the Feature 20 engine): each
 *                           tunnel is RESOLVED — its referenced credential and
 *                           jump hosts are decrypted and inlined into the engine's
 *                           `{ destination, sshServer, jumps }` shape (resolve.js),
 *                           so the engine is unchanged by the reference model.
 */
"use strict";

const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const { validateDefinition } = require("./validate");
const { decryptCredential } = require("./credential-secrets");
const { resolveDefinition, summariseRoute } = require("./resolve");

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidDefinitionError(errors) {
  const err = new Error("invalid tunnel definition");
  err.code = "INVALID_DEFINITION";
  err.errors = errors;
  return err;
}

/** Apply store-level defaults to an incoming definition (post-validation). */
function applyDefaults(def) {
  return {
    ...def,
    enabled: def.enabled ?? true,
    keepAlive: def.keepAlive ?? false,
    autoReconnect: def.autoReconnect ?? false,
    jumpHostIds: Array.isArray(def.jumpHostIds) ? def.jumpHostIds : [],
  };
}

/** Index an array of `{ id }` records into a Map for O(1) reference lookup. */
function indexById(records) {
  const map = new Map();
  for (const r of records) if (r && r.id) map.set(r.id, r);
  return map;
}

class TunnelStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    return readDoc(this._paths);
  }

  _writeTunnels(doc, tunnels) {
    writeDoc(this._paths, { ...doc, tunnels });
  }

  /** Renderer view of a stored tunnel: reference record + derived order/summary. */
  _view(def, order, jumpHostsById) {
    return {
      ...def,
      order,
      routeSummary: summariseRoute(def, { jumpHostsById }),
    };
  }

  // ── Renderer-facing reads (reference shape; no secrets on a tunnel) ───────────

  /** Every definition, in order, with a derived route summary. */
  list() {
    const doc = this._read();
    const jumpHostsById = indexById(doc.jumpHosts);
    return doc.tunnels.map((def, i) => this._view(def, i, jumpHostsById));
  }

  /** One definition by id, or null if absent. */
  get(id) {
    const doc = this._read();
    const i = doc.tunnels.findIndex((d) => d && d.id === id);
    if (i === -1) return null;
    return this._view(doc.tunnels[i], i, indexById(doc.jumpHosts));
  }

  // ── In-process reads (resolved + decrypted — engine only, never over IPC) ─────

  /** Every definition, resolved into the engine shape with secrets decrypted. */
  listDecrypted() {
    const doc = this._read();
    const refs = this._decryptedRefs(doc);
    return doc.tunnels.map((def, i) => ({
      ...resolveDefinition(def, refs),
      order: i,
    }));
  }

  /** One definition by id, resolved + decrypted, or null if absent. */
  getDecrypted(id) {
    const doc = this._read();
    const i = doc.tunnels.findIndex((d) => d && d.id === id);
    if (i === -1) return null;
    return {
      ...resolveDefinition(doc.tunnels[i], this._decryptedRefs(doc)),
      order: i,
    };
  }

  /** Reference maps for the resolver: credentials decrypted, jump hosts as-is. */
  _decryptedRefs(doc) {
    const credentialsById = new Map();
    for (const c of doc.credentials) {
      if (c && c.id) credentialsById.set(c.id, decryptCredential(c));
    }
    return { credentialsById, jumpHostsById: indexById(doc.jumpHosts) };
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /**
   * Create a new definition. Returns the renderer-facing view. Throws
   * INVALID_DEFINITION (with a field-keyed `.errors`) on a bad definition or a
   * dangling credential / jump-host reference.
   */
  create(def) {
    const { valid, errors } = validateDefinition(def);
    if (!valid) throw invalidDefinitionError(errors);

    const doc = this._read();
    this._assertRefs(doc, def);

    const record = applyDefaults(def);
    record.id = io.newUUID();
    delete record.order; // derived from array position, never stored
    delete record.routeSummary; // derived, never stored
    doc.tunnels.push(record);
    this._writeTunnels(doc, doc.tunnels);
    return this._view(record, doc.tunnels.length - 1, indexById(doc.jumpHosts));
  }

  /**
   * Patch an existing definition (shallow top-level override). Throws NOT_FOUND
   * for an unknown id, INVALID_DEFINITION on a bad merged result or dangling ref.
   */
  update(id, patch) {
    const doc = this._read();
    const i = doc.tunnels.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`tunnel not found: ${id}`);

    const merged = applyDefaults({ ...doc.tunnels[i], ...patch, id });
    const { valid, errors } = validateDefinition(merged);
    if (!valid) throw invalidDefinitionError(errors);
    this._assertRefs(doc, merged);

    delete merged.order;
    delete merged.routeSummary;
    doc.tunnels[i] = merged;
    this._writeTunnels(doc, doc.tunnels);
    return this._view(merged, i, indexById(doc.jumpHosts));
  }

  /** Remove a definition. Throws NOT_FOUND for an unknown id. */
  delete(id) {
    const doc = this._read();
    const i = doc.tunnels.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`tunnel not found: ${id}`);
    doc.tunnels.splice(i, 1);
    this._writeTunnels(doc, doc.tunnels);
    return { id };
  }

  /**
   * Reorder definitions to match `ids`. Ids not present are ignored; any existing
   * definition missing from `ids` is appended after the listed ones in its current
   * order, so a stale/partial list can never drop a tunnel. Returns the new
   * renderer-facing list.
   */
  reorder(ids) {
    const doc = this._read();
    const order = Array.isArray(ids) ? ids : [];
    const byId = new Map(doc.tunnels.map((d) => [d && d.id, d]));

    const next = [];
    const placed = new Set();
    for (const id of order) {
      const def = byId.get(id);
      if (def && !placed.has(id)) {
        next.push(def);
        placed.add(id);
      }
    }
    for (const def of doc.tunnels) {
      if (def && !placed.has(def.id)) next.push(def);
    }

    this._writeTunnels(doc, next);
    const jumpHostsById = indexById(doc.jumpHosts);
    return next.map((def, i) => this._view(def, i, jumpHostsById));
  }

  /**
   * Reject a `credentialId` / `jumpHostIds` that doesn't resolve, as a field-keyed
   * INVALID_DEFINITION — the referential-integrity half of validation, which the
   * pure structural validator can't check without the sibling records.
   */
  _assertRefs(doc, def) {
    const errors = {};
    const credExists = doc.credentials.some(
      (c) => c && c.id === def.credentialId,
    );
    if (!credExists) {
      errors.credentialId = "referenced credential does not exist";
    }
    const jumpIds = Array.isArray(def.jumpHostIds) ? def.jumpHostIds : [];
    jumpIds.forEach((id, i) => {
      if (!doc.jumpHosts.some((j) => j && j.id === id)) {
        errors[`jumpHostIds[${i}]`] = "referenced jump host does not exist";
      }
    });
    if (Object.keys(errors).length > 0) throw invalidDefinitionError(errors);
  }
}

module.exports = { TunnelStore };
