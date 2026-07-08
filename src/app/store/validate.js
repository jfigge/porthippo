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
 * validate.js — Pure structural validation of a tunnel definition.
 *
 * `validateDefinition(def)` returns `{ valid, errors }` where `errors` is keyed
 * by a dotted field path (e.g. `"localPort"`, `"destination.host"`,
 * `"sshServer.auth[0].privateKeyPath"`, `"jumps[1].port"`) so Feature 40 can show
 * each message inline against its field. No I/O, no mutation — safe to call from
 * anywhere (the store gates create/update on it; the renderer can pre-flight).
 *
 * This module also owns the auth taxonomy — which auth `type`s exist and which
 * secret field (if any) each one carries — so the validator and the store agree
 * on where a hop's secret lives.
 */
"use strict";

/** The auth methods a hop may offer, tried by the engine in array order. */
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
 * Validate one hop (the SSH server, or a jump host — same shape) into `errors`.
 * @param {*} hop
 * @param {string} prefix  dotted path prefix, e.g. "sshServer" or "jumps[0]"
 * @param {Object<string,string>} errors  accumulator (mutated)
 */
function validateHop(hop, prefix, errors) {
  if (!hop || typeof hop !== "object") {
    errors[prefix] = "hop must be an object";
    return;
  }
  if (!isNonEmptyString(hop.host)) {
    errors[`${prefix}.host`] = "host is required";
  }
  if (!isValidPort(hop.port)) {
    errors[`${prefix}.port`] =
      `port must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }
  if (!isNonEmptyString(hop.user)) {
    errors[`${prefix}.user`] = "user is required";
  }
  if (!Array.isArray(hop.auth) || hop.auth.length === 0) {
    errors[`${prefix}.auth`] = "at least one auth method is required";
    return;
  }
  hop.auth.forEach((entry, i) =>
    validateAuth(entry, `${prefix}.auth[${i}]`, errors),
  );
}

/**
 * Validate one auth entry (a member of the discriminated union) into `errors`.
 * Secret values (`password`, `passphrase`) are write-only and may legitimately be
 * absent in an update patch that keeps the existing secret, so their presence is
 * NOT required here — only their surrounding structure is checked.
 *
 * @param {*} entry
 * @param {string} prefix  dotted path, e.g. "sshServer.auth[0]"
 * @param {Object<string,string>} errors
 */
function validateAuth(entry, prefix, errors) {
  if (!entry || typeof entry !== "object") {
    errors[prefix] = "auth entry must be an object";
    return;
  }
  if (!AUTH_TYPES.includes(entry.type)) {
    errors[`${prefix}.type`] = `type must be one of ${AUTH_TYPES.join(", ")}`;
    return;
  }
  if (entry.type === "key" && !isNonEmptyString(entry.privateKeyPath)) {
    errors[`${prefix}.privateKeyPath`] =
      "privateKeyPath is required for key auth";
  }
}

/**
 * Validate a full tunnel definition.
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

  // The tunnel-terminating SSH server.
  if (!def.sshServer) {
    errors.sshServer = "sshServer is required";
  } else {
    validateHop(def.sshServer, "sshServer", errors);
  }

  // Ordered jump-host chain (optional; empty = direct).
  if (def.jumps !== undefined) {
    if (!Array.isArray(def.jumps)) {
      errors.jumps = "jumps must be an array";
    } else {
      def.jumps.forEach((hop, i) => validateHop(hop, `jumps[${i}]`, errors));
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

module.exports = {
  AUTH_TYPES,
  secretFieldForAuthType,
  validateDefinition,
};
