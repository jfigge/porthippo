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
 * jump-host-store.js — reusable, named SSH jump hosts (Feature 45).
 *
 * A jump host is `{ id, label, host, port, credentialId }` — it carries no secret
 * of its own; its authentication lives in the credential it references. A tunnel
 * holds an ordered list of jump-host ids (`jumpHostIds`). Records share the one
 * definitions document with tunnels and credentials (definitions-doc.js).
 *
 * A jump host that is still referenced by a tunnel cannot be deleted (IN_USE);
 * creating / updating one whose `credentialId` doesn't resolve is rejected.
 */
"use strict";

const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const { validateJumpHost } = require("./validate");

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidJumpHostError(errors) {
  const err = new Error("invalid jump host");
  err.code = "INVALID_JUMP_HOST";
  err.errors = errors;
  return err;
}

/** Build the "still referenced" error blocking a delete. */
function inUseError(id, references) {
  const err = new Error(`jump host in use: ${id}`);
  err.code = "IN_USE";
  err.references = references;
  return err;
}

const DEFAULT_PORT = 22;

class JumpHostStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    return readDoc(this._paths);
  }

  _writeJumpHosts(doc, jumpHosts) {
    writeDoc(this._paths, { ...doc, jumpHosts });
  }

  /** Every jump host, in stored order. */
  list() {
    return this._read().jumpHosts.map((j) => ({ ...j }));
  }

  /** One jump host by id, or null if absent. */
  get(id) {
    const jh = this._read().jumpHosts.find((j) => j && j.id === id);
    return jh ? { ...jh } : null;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /** Create a jump host. Rejects a dangling `credentialId`. */
  create(jump) {
    const record = applyDefaults(jump);
    const { valid, errors } = validateJumpHost(record);
    if (!valid) throw invalidJumpHostError(errors);

    const doc = this._read();
    this._assertCredentialExists(doc, record.credentialId, errors);

    record.id = io.newUUID();
    doc.jumpHosts.push(record);
    this._writeJumpHosts(doc, doc.jumpHosts);
    return { ...record };
  }

  /** Patch a jump host. Throws NOT_FOUND / INVALID_JUMP_HOST. */
  update(id, patch) {
    const doc = this._read();
    const i = doc.jumpHosts.findIndex((j) => j && j.id === id);
    if (i === -1) throw io.notFoundError(`jump host not found: ${id}`);

    const merged = applyDefaults({ ...doc.jumpHosts[i], ...patch, id });
    const { valid, errors } = validateJumpHost(merged);
    if (!valid) throw invalidJumpHostError(errors);
    this._assertCredentialExists(doc, merged.credentialId, errors);

    doc.jumpHosts[i] = merged;
    this._writeJumpHosts(doc, doc.jumpHosts);
    return { ...merged };
  }

  /**
   * Remove a jump host. Blocked (IN_USE) while any tunnel or console still lists it
   * in its `jumpHostIds`. Throws NOT_FOUND for an unknown id.
   */
  delete(id) {
    const doc = this._read();
    const i = doc.jumpHosts.findIndex((j) => j && j.id === id);
    if (i === -1) throw io.notFoundError(`jump host not found: ${id}`);

    const lists = (arr, type, nameOf) =>
      arr
        .filter(
          (r) =>
            r && Array.isArray(r.jumpHostIds) && r.jumpHostIds.includes(id),
        )
        .map((r) => ({ type, id: r.id, label: nameOf(r) || r.id }));
    const references = [
      ...lists(doc.tunnels, "tunnel", (t) => t.name),
      ...lists(doc.consoles, "console", (c) => c.name),
    ];
    if (references.length > 0) throw inUseError(id, references);

    doc.jumpHosts.splice(i, 1);
    this._writeJumpHosts(doc, doc.jumpHosts);
    return { id };
  }

  /** Reject a credentialId that doesn't resolve, as a field-keyed error. */
  _assertCredentialExists(doc, credentialId, errors) {
    const exists = doc.credentials.some((c) => c && c.id === credentialId);
    if (!exists) {
      throw invalidJumpHostError({
        ...errors,
        credentialId: "referenced credential does not exist",
      });
    }
  }
}

/** Fill the SSH default port so a blank port field lands as 22. */
function applyDefaults(jump) {
  const out = { ...jump };
  if (out.port === undefined || out.port === null) out.port = DEFAULT_PORT;
  return out;
}

module.exports = { JumpHostStore };
