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
 * The SSH server is implied from the destination unless `sshHost` overrides it
 * (a bastion forwarding onward), so only the destination, the local port, and a
 * `credentialId` are structurally required; `sshHost` / `sshPort` are optional.
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

  // SSH server override — blank means "same box as the destination". Only its
  // structure is checked when present; it defaults in the resolver.
  if (def.sshHost !== undefined && !isNonEmptyString(def.sshHost)) {
    errors.sshHost = "sshHost must be a non-empty string when set";
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
