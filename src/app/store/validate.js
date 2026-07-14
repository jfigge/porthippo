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
 * validate.js — Pure structural validation of the stored record types.
 *
 * Feature 45 splits the old self-contained tunnel definition into three records:
 * a `tunnel` that references a `credential` by id and an ordered list of
 * `jumpHost`s by id. Each has its own validator returning `{ valid, errors }`
 * where `errors` is keyed by a dotted field path (e.g. `"localPort"`,
 * `"destination.host"`, `"credentialId"`, `"jumpHostIds[1]"`) so the Definition
 * editor can show each message inline against its field. No I/O, no mutation —
 * safe to call from anywhere (the stores gate writes on it; the renderer
 * pre-flights). Referential integrity (does a referenced id actually exist?) is a
 * store-level concern, not a structural one, and lives in the stores.
 *
 * This module also owns the auth taxonomy — which auth `type`s exist and which
 * secret field (if any) each one carries — so the credential store and validator
 * agree on where a credential's secret lives.
 */
"use strict";

/** The auth methods a credential may use. */
const AUTH_TYPES = ["agent", "key", "password"];

/**
 * The write-only secret field for an auth `type`, or null when it carries none.
 * `key` auth may protect its private key with a `passphrase`; `password` auth
 * holds a `password`; `agent` auth has no stored secret.
 *
 * @param {string} type
 * @returns {"password"|"passphrase"|null}
 */
function secretFieldForAuthType(type) {
  if (type === "password") return "password";
  if (type === "key") return "passphrase";
  return null;
}

const MIN_PORT = 1;
const MAX_PORT = 65535;

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function isValidPort(v) {
  return Number.isInteger(v) && v >= MIN_PORT && v <= MAX_PORT;
}

/**
 * Validate a tunnel definition (reference shape).
 *
 * A tunnel listens on a local Entry (`bindHost` + `localPort`), connects to a
 * mandatory Target server (`sshHost`, port defaulting to 22), and forwards to an
 * Exit on that server (`destination`). So the local port, destination, target
 * server (`sshHost`) and a `credentialId` are all structurally required;
 * `sshPort` / `bindHost` are optional (defaulted in the resolver), and
 * `entryAddress` / `exitAddress` are the verbatim strings the editor round-trips.
 *
 * @param {*} def
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
function validateDefinition(def) {
  const errors = {};

  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return { valid: false, errors: { _: "definition must be an object" } };
  }

  if (!isNonEmptyString(def.name)) {
    errors.name = "name is required";
  }
  if (!isValidPort(def.localPort)) {
    errors.localPort = `localPort must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }
  if (def.bindHost !== undefined && !isNonEmptyString(def.bindHost)) {
    errors.bindHost = "bindHost must be a non-empty string when set";
  }

  // Destination (host + port) — the far end the tunnel exposes locally.
  if (!def.destination || typeof def.destination !== "object") {
    errors.destination = "destination is required";
  } else {
    if (!isNonEmptyString(def.destination.host)) {
      errors["destination.host"] = "destination host is required";
    }
    if (!isValidPort(def.destination.port)) {
      errors["destination.port"] =
        `destination port must be an integer ${MIN_PORT}–${MAX_PORT}`;
    }
  }

  // Target server — the SSH server the tunnel connects to. Mandatory (it is the
  // far end of the tunnel); its port defaults to 22 in the resolver when unset.
  if (!isNonEmptyString(def.sshHost)) {
    errors.sshHost = "target server is required";
  }
  if (def.sshPort !== undefined && !isValidPort(def.sshPort)) {
    errors.sshPort = `sshPort must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }

  // The SSH server's credential (by id). Existence is checked by the store.
  if (!isNonEmptyString(def.credentialId)) {
    errors.credentialId = "a credential is required";
  }

  // Ordered jump-host chain (optional; empty = direct). Each entry is an id.
  if (def.jumpHostIds !== undefined) {
    if (!Array.isArray(def.jumpHostIds)) {
      errors.jumpHostIds = "jumpHostIds must be an array";
    } else {
      def.jumpHostIds.forEach((id, i) => {
        if (!isNonEmptyString(id)) {
          errors[`jumpHostIds[${i}]`] = "jump host reference must be a string";
        }
      });
    }
  }

  if (
    def.lingerMs !== undefined &&
    !(Number.isInteger(def.lingerMs) && def.lingerMs >= 0)
  ) {
    errors.lingerMs = "lingerMs must be an integer ≥ 0";
  }
  if (def.keepAlive !== undefined && typeof def.keepAlive !== "boolean") {
    errors.keepAlive = "keepAlive must be a boolean";
  }
  if (def.enabled !== undefined && typeof def.enabled !== "boolean") {
    errors.enabled = "enabled must be a boolean";
  }
  if (
    def.autoReconnect !== undefined &&
    typeof def.autoReconnect !== "boolean"
  ) {
    errors.autoReconnect = "autoReconnect must be a boolean";
  }

  // Verbatim Entry / Exit strings the editor stores for faithful round-trip. The
  // extracted concrete fields above carry the real constraints, so only the type
  // is checked here.
  if (def.entryAddress !== undefined && typeof def.entryAddress !== "string") {
    errors.entryAddress = "entryAddress must be a string";
  }
  if (def.exitAddress !== undefined && typeof def.exitAddress !== "string") {
    errors.exitAddress = "exitAddress must be a string";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a reusable credential record. The secret value (`password` /
 * `passphrase`) is write-only and may legitimately be absent in an update patch
 * that keeps the existing secret, so its presence is NOT required — only the
 * surrounding structure is checked.
 *
 * @param {*} cred
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
function validateCredential(cred) {
  const errors = {};

  if (!cred || typeof cred !== "object" || Array.isArray(cred)) {
    return { valid: false, errors: { _: "credential must be an object" } };
  }

  if (!isNonEmptyString(cred.label)) {
    errors.label = "label is required";
  }
  if (!isNonEmptyString(cred.user)) {
    errors.user = "user is required";
  }
  if (!AUTH_TYPES.includes(cred.authType)) {
    errors.authType = `authType must be one of ${AUTH_TYPES.join(", ")}`;
  } else if (cred.authType === "key" && !isNonEmptyString(cred.keyPath)) {
    errors.keyPath = "keyPath is required for key auth";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a reusable jump-host record. It references a credential by id (whose
 * existence the store checks).
 *
 * @param {*} jump
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
function validateJumpHost(jump) {
  const errors = {};

  if (!jump || typeof jump !== "object" || Array.isArray(jump)) {
    return { valid: false, errors: { _: "jump host must be an object" } };
  }

  if (!isNonEmptyString(jump.label)) {
    errors.label = "label is required";
  }
  if (!isNonEmptyString(jump.host)) {
    errors.host = "host is required";
  }
  if (!isValidPort(jump.port)) {
    errors.port = `port must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }
  if (!isNonEmptyString(jump.credentialId)) {
    errors.credentialId = "a credential is required";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = {
  AUTH_TYPES,
  secretFieldForAuthType,
  validateDefinition,
  validateCredential,
  validateJumpHost,
};
