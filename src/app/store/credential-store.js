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
 * credential-store.js — reusable, named SSH credentials (Feature 45).
 *
 * A credential is `{ id, label, user, authType, keyPath?, <secret> }` selected by
 * a tunnel (its SSH server) or a jump host. Secrets are write-only across IPC and
 * sealed at rest exactly like the pre-Feature-45 per-hop auth: the renderer reads
 * `hasSecret` and never the value (see credential-secrets.js). The records share
 * the one definitions document with tunnels and jump hosts (definitions-doc.js).
 *
 * A credential that is still referenced by a tunnel or a jump host cannot be
 * deleted (the store throws IN_USE); the renderer surfaces that as a guard.
 */
"use strict";

const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const { validateCredential } = require("./validate");
const {
  SECRET_FIELDS,
  sealCredential,
  stripCredential,
  decryptCredential,
} = require("./credential-secrets");

/** Build the tagged error the IPC layer turns into a field-keyed envelope. */
function invalidCredentialError(errors) {
  const err = new Error("invalid credential");
  err.code = "INVALID_CREDENTIAL";
  err.errors = errors;
  return err;
}

/** Build the "still referenced" error blocking a delete. */
function inUseError(id, references) {
  const err = new Error(`credential in use: ${id}`);
  err.code = "IN_USE";
  err.references = references;
  return err;
}

class CredentialStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    return readDoc(this._paths);
  }

  _writeCredentials(doc, credentials) {
    writeDoc(this._paths, { ...doc, credentials });
  }

  // ── Renderer-facing reads (secrets stripped to hasSecret) ────────────────────

  /** Every credential, secrets stripped. */
  list() {
    return this._read().credentials.map(stripCredential);
  }

  /** One credential by id, secret stripped, or null if absent. */
  get(id) {
    const cred = this._read().credentials.find((c) => c && c.id === id);
    return cred ? stripCredential(cred) : null;
  }

  // ── In-process reads (secrets decrypted — engine only, never over IPC) ───────

  /** Every credential, secrets decrypted to plaintext. */
  listDecrypted() {
    return this._read().credentials.map(decryptCredential);
  }

  /** One credential by id, secret decrypted, or null if absent. */
  getDecrypted(id) {
    const cred = this._read().credentials.find((c) => c && c.id === id);
    return cred ? decryptCredential(cred) : null;
  }

  // ── Mutations ────────────────────────────────────────────────────────────────

  /** Create a credential (plaintext secret sealed on write). Returns the view. */
  create(cred) {
    const { valid, errors } = validateCredential(cred);
    if (!valid) throw invalidCredentialError(errors);

    const doc = this._read();
    const sealed = sealCredential(cred, null);
    sealed.id = io.newUUID();
    doc.credentials.push(sealed);
    this._writeCredentials(doc, doc.credentials);
    return stripCredential(sealed);
  }

  /**
   * Patch a credential. Secrets in the merged result are sealed, retaining a kept
   * secret from the prior record. Throws NOT_FOUND / INVALID_CREDENTIAL.
   */
  update(id, patch) {
    const doc = this._read();
    const i = doc.credentials.findIndex((c) => c && c.id === id);
    if (i === -1) throw io.notFoundError(`credential not found: ${id}`);

    const existing = doc.credentials[i];
    const merged = { ...existing, ...patch, id };
    // The secret must follow the PATCH's intent (a new value / hasSecret:true to
    // keep / neither to clear), never a ciphertext inherited from `existing` — a
    // carried-over sealed value would defeat clearing. Drop any secret field the
    // patch didn't itself send; sealCredential then re-derives it, retaining the
    // stored ciphertext only when the patch asks via hasSecret.
    for (const f of SECRET_FIELDS) {
      if (!(f in patch)) delete merged[f];
    }
    const { valid, errors } = validateCredential(merged);
    if (!valid) throw invalidCredentialError(errors);

    const sealed = sealCredential(merged, existing);
    sealed.id = id;
    doc.credentials[i] = sealed;
    this._writeCredentials(doc, doc.credentials);
    return stripCredential(sealed);
  }

  /**
   * Remove a credential. Blocked (IN_USE) while any tunnel or jump host still
   * references it. Throws NOT_FOUND for an unknown id.
   */
  delete(id) {
    const doc = this._read();
    const i = doc.credentials.findIndex((c) => c && c.id === id);
    if (i === -1) throw io.notFoundError(`credential not found: ${id}`);

    const references = this._referencesOf(doc, id);
    if (references.length > 0) throw inUseError(id, references);

    doc.credentials.splice(i, 1);
    this._writeCredentials(doc, doc.credentials);
    return { id };
  }

  /**
   * Names of the tunnels / jump hosts referencing a credential, for the delete
   * guard and the renderer's warning.
   * @returns {Array<{ type: "tunnel"|"jumpHost", id: string, label: string }>}
   */
  _referencesOf(doc, id) {
    const refs = [];
    for (const t of doc.tunnels) {
      if (t && t.credentialId === id) {
        refs.push({ type: "tunnel", id: t.id, label: t.name || t.id });
      }
    }
    for (const j of doc.jumpHosts) {
      if (j && j.credentialId === id) {
        refs.push({ type: "jumpHost", id: j.id, label: j.label || j.id });
      }
    }
    return refs;
  }
}

module.exports = { CredentialStore };
