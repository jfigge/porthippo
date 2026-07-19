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
 * console-store.js — Durable, ordered collection of console definitions (Feature
 * 200), a lean sibling of tunnel-store.js.
 *
 * A console is an interactive-shell target: a REFERENCE record holding a
 * `credentialId` (its SSH server's credential) and an ordered list of
 * `jumpHostIds`, plus a target `sshHost`/`sshPort`. Like a tunnel it carries no
 * secret of its own — secrets live only in the credential store — and it reuses
 * the same credential + jump-host pools tunnels do. Consoles live as the fifth
 * sibling array in the shared `tunnels.json` document (definitions-doc.js); array
 * position IS display order.
 *
 * Two read shapes mirror tunnel-store's:
 *   - list() / get()          renderer-facing: the stored record + a derived
 *                             `order` and `routeSummary` (no secret to strip).
 *   - listDecrypted() / getDecrypted()  in-process (the console manager): each
 *                             console is RESOLVED into `{ sshServer, jumps }` with
 *                             its referenced credential + jump hosts decrypted and
 *                             inlined (resolve.js), ready for connectChain().
 */
"use strict";

const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const { validateConsole } = require("./validate");
const { decryptCredential } = require("./credential-secrets");
const { resolveConsole, summariseConsoleRoute } = require("./resolve");

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidConsoleError(errors) {
  const err = new Error("invalid console definition");
  err.code = "INVALID_DEFINITION";
  err.errors = errors;
  return err;
}

/** Apply store-level defaults to an incoming console (post-validation). */
function applyDefaults(def) {
  return {
    ...def,
    jumpHostIds: Array.isArray(def.jumpHostIds) ? def.jumpHostIds : [],
  };
}

// Optional fields the editor omits from its payload when the user leaves them
// blank. On update the (full, authoritative) payload's ABSENCE of one means the
// user cleared it, so a shallow merge must not resurrect the stored value. `sshHost`
// (the mandatory target server) is NOT here — omitting it keeps the stored value.
const OPTIONAL_FIELDS = ["sshPort"];

/** Index an array of `{ id }` records into a Map for O(1) reference lookup. */
function indexById(records) {
  const map = new Map();
  for (const r of records) if (r && r.id) map.set(r.id, r);
  return map;
}

class ConsoleStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    return readDoc(this._paths);
  }

  _writeConsoles(doc, consoles) {
    writeDoc(this._paths, { ...doc, consoles });
  }

  /** Renderer view of a stored console: record + derived order/routeSummary. */
  _view(def, order, jumpHostsById) {
    return {
      ...def,
      order,
      routeSummary: summariseConsoleRoute(def, { jumpHostsById }),
    };
  }

  // ── Renderer-facing reads (reference shape; no secrets on a console) ──────────

  /** Every console, in order, with a derived route summary. */
  list() {
    const doc = this._read();
    const jumpHostsById = indexById(doc.jumpHosts);
    return doc.consoles.map((def, i) => this._view(def, i, jumpHostsById));
  }

  /** One console by id, or null if absent. */
  get(id) {
    const doc = this._read();
    const i = doc.consoles.findIndex((d) => d && d.id === id);
    if (i === -1) return null;
    return this._view(doc.consoles[i], i, indexById(doc.jumpHosts));
  }

  // ── In-process reads (resolved + decrypted — manager only, never over IPC) ────

  /** Every console, resolved into the hop shape with secrets decrypted. */
  listDecrypted() {
    const doc = this._read();
    const refs = this._decryptedRefs(doc);
    return doc.consoles.map((def, i) => ({
      ...resolveConsole(def, refs),
      order: i,
    }));
  }

  /** One console by id, resolved + decrypted, or null if absent. */
  getDecrypted(id) {
    const doc = this._read();
    const i = doc.consoles.findIndex((d) => d && d.id === id);
    if (i === -1) return null;
    return {
      ...resolveConsole(doc.consoles[i], this._decryptedRefs(doc)),
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
   * Create a new console. Returns the renderer-facing view. Throws
   * INVALID_DEFINITION (with a field-keyed `.errors`) on a bad definition or a
   * dangling credential / jump-host reference.
   */
  create(def) {
    const { valid, errors } = validateConsole(def);
    if (!valid) throw invalidConsoleError(errors);

    const doc = this._read();
    this._assertRefs(doc, def);

    const record = applyDefaults(def);
    record.id = io.newUUID();
    delete record.order; // derived from array position, never stored
    delete record.routeSummary; // derived, never stored
    doc.consoles.push(record);
    this._writeConsoles(doc, doc.consoles);
    return this._view(
      record,
      doc.consoles.length - 1,
      indexById(doc.jumpHosts),
    );
  }

  /**
   * Patch an existing console (shallow top-level override). The OPTIONAL_FIELDS
   * are authoritative: one absent from `patch` is treated as cleared. Throws
   * NOT_FOUND for an unknown id, INVALID_DEFINITION on a bad merged result or
   * dangling ref.
   */
  update(id, patch) {
    const doc = this._read();
    const i = doc.consoles.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`console not found: ${id}`);

    const merged = applyDefaults({ ...doc.consoles[i], ...patch, id });
    for (const f of OPTIONAL_FIELDS) {
      if (!(f in patch)) delete merged[f];
    }
    const { valid, errors } = validateConsole(merged);
    if (!valid) throw invalidConsoleError(errors);
    this._assertRefs(doc, merged);

    delete merged.order;
    delete merged.routeSummary;
    doc.consoles[i] = merged;
    this._writeConsoles(doc, doc.consoles);
    return this._view(merged, i, indexById(doc.jumpHosts));
  }

  /** Remove a console. Throws NOT_FOUND for an unknown id. */
  delete(id) {
    const doc = this._read();
    const i = doc.consoles.findIndex((d) => d && d.id === id);
    if (i === -1) throw io.notFoundError(`console not found: ${id}`);
    doc.consoles.splice(i, 1);
    this._writeConsoles(doc, doc.consoles);
    return { id };
  }

  /**
   * Reorder consoles to match `ids`. Ids not present are ignored; any existing
   * console missing from `ids` is appended after the listed ones in its current
   * order, so a stale/partial list can never drop a console. Returns the new
   * renderer-facing list.
   */
  reorder(ids) {
    const doc = this._read();
    const order = Array.isArray(ids) ? ids : [];
    const byId = new Map(doc.consoles.map((d) => [d && d.id, d]));

    const next = [];
    const placed = new Set();
    for (const id of order) {
      const def = byId.get(id);
      if (def && !placed.has(id)) {
        next.push(def);
        placed.add(id);
      }
    }
    for (const def of doc.consoles) {
      if (def && !placed.has(def.id)) next.push(def);
    }

    this._writeConsoles(doc, next);
    const jumpHostsById = indexById(doc.jumpHosts);
    return next.map((def, i) => this._view(def, i, jumpHostsById));
  }

  /**
   * Reject a `credentialId` / `jumpHostIds` that doesn't resolve, as a field-keyed
   * INVALID_DEFINITION — the referential-integrity half of validation.
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
    if (Object.keys(errors).length > 0) throw invalidConsoleError(errors);
  }
}

module.exports = { ConsoleStore };
