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
 * credential-secrets.js — the write-only-secret transforms for a credential
 * record, shared by the credential store (which owns the records) and the tunnel
 * store's decrypted read path (which resolves a referenced credential into an
 * engine hop and therefore needs the plaintext in-process).
 *
 * A credential carries at most one secret, named by its `authType`
 * (`secretFieldForAuthType`): `password` auth holds a `password`, `key` auth may
 * hold a key `passphrase`, `agent` auth holds none. On disk the secret lives as
 * `{ enc: "<ciphertext>" }` (sealed by crypto.js). There are three read shapes,
 * mirroring the pre-Feature-45 per-hop auth handling:
 *   - stripCredential   renderer-facing: the secret is replaced with a `hasSecret`
 *                       boolean — the plaintext never crosses IPC.
 *   - decryptCredential  in-process (the engine resolver): the secret is decrypted
 *                       back to a plaintext string.
 *
 * On write the renderer sends a NEW secret as a plaintext string (sealed here) or,
 * to keep an existing secret it never received, sends the record back with
 * `hasSecret: true` and no value (the on-disk ciphertext is retained). Sending
 * `hasSecret: false` / omitting it clears the secret.
 */
"use strict";

const crypto = require("./crypto");
const { secretFieldForAuthType } = require("./validate");

/** Secret field names — the union of every secretFieldForAuthType result. */
const SECRET_FIELDS = ["password", "passphrase"];

/** True when `v` is a sealed secret object `{ enc: "<ciphertext>" }`. */
function isSealed(v) {
  return Boolean(v) && typeof v === "object" && typeof v.enc === "string";
}

/**
 * Produce the on-disk form of an incoming credential, sealing its secret.
 * `existing` is the prior on-disk record (or undefined), consulted only to retain
 * a secret the caller asked to keep (`hasSecret: true` with no value).
 */
function sealCredential(incoming, existing) {
  if (!incoming || typeof incoming !== "object") return incoming;
  const out = { ...incoming };
  delete out.hasSecret; // a read-side marker; never persisted
  delete out.decryptError; // a read-side marker; never persisted

  const field = secretFieldForAuthType(incoming.authType);
  // Drop any secret field that doesn't belong to this auth type (e.g. a stray
  // password on a `key` credential) so an authType switch can't orphan a secret.
  for (const f of SECRET_FIELDS) {
    if (f !== field) delete out[f];
  }
  // `key` auth's optional key path only belongs to `key` auth.
  if (incoming.authType !== "key") delete out.keyPath;

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
function stripCredential(cred) {
  if (!cred || typeof cred !== "object") return cred;
  const out = { ...cred };
  const field = secretFieldForAuthType(cred.authType);
  for (const f of SECRET_FIELDS) delete out[f];
  delete out.decryptError;
  if (field) out.hasSecret = isSealed(cred[field]);
  return out;
}

/** In-process (engine) form: decrypt the secret back to a plaintext string. */
function decryptCredential(cred) {
  if (!cred || typeof cred !== "object") return cred;
  const out = { ...cred };
  const field = secretFieldForAuthType(cred.authType);
  if (field && isSealed(cred[field])) {
    try {
      out[field] = crypto.decryptString(cred[field].enc);
    } catch (err) {
      if (!(err instanceof crypto.DecryptError)) throw err;
      // A secret that can't be decrypted (keystore unavailable, rotated key) is
      // blanked and flagged rather than surfaced as stale ciphertext; the engine
      // treats a flagged entry as "no usable secret" and moves on.
      out[field] = "";
      out.decryptError = err.code;
    }
  }
  return out;
}

module.exports = {
  SECRET_FIELDS,
  isSealed,
  sealCredential,
  stripCredential,
  decryptCredential,
};
