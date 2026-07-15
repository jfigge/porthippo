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

// validate.js — renderer-side copy of the store record validators.
//
// The authoritative validators live in the main process at
// `src/app/store/validate.js` (CommonJS), which the sandboxed renderer can't
// import. This is a verbatim ES-module port so the Definition editor + the
// credential / jump-host editors can validate inline as the user types, before
// ever hitting the store. The two copies are held identical by
// `validate-parity.test.js` — if you change one, change both.
//
// Each validator returns `{ valid, errors }` where `errors` is keyed by a dotted
// field path (e.g. `"localPort"`, `"destination.host"`, `"credentialId"`,
// `"jumpHostIds[1]"`) so each message can be shown inline against its field.

/** The auth methods a credential may use. */
export const AUTH_TYPES = ["agent", "key", "password"];

/**
 * The forwarding directions a tunnel may take (Feature 110):
 *   - `local`   — the default: bind a local port and forward it through the SSH
 *                 chain to a destination (`ssh -L`).
 *   - `remote`  — bind a port on the SSH server and forward it back to a local
 *                 target (`ssh -R`).
 *   - `dynamic` — bind a local SOCKS5 proxy that forwards each request through the
 *                 SSH chain (`ssh -D`).
 * A record with no `type` is treated as `local` so pre-Feature-110 tunnels are
 * unchanged.
 */
export const TUNNEL_TYPES = ["local", "remote", "dynamic"];

/** Normalise a possibly-absent `type` to one of TUNNEL_TYPES (default local). */
export function normaliseTunnelType(type) {
  return TUNNEL_TYPES.includes(type) ? type : "local";
}

/**
 * The write-only secret field for an auth `type`, or null when it carries none.
 * `key` auth may protect its private key with a `passphrase`; `password` auth
 * holds a `password`; `agent` auth has no stored secret.
 *
 * @param {string} type
 * @returns {"password"|"passphrase"|null}
 */
export function secretFieldForAuthType(type) {
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
 * The required fields depend on the forwarding `type` (Feature 110; absent ⇒
 * `local`):
 *   - local   — Entry (`bindHost` + `localPort`), a Target server (`sshHost`) and
 *               an Exit (`destination`); forwards the local port to the Exit.
 *   - remote  — a Target server (`sshHost`), a `remoteBind` port on it, and a
 *               local target (`destination`); forwards the remote port back here.
 *   - dynamic — a local SOCKS listener (`bindHost` + `localPort`) and a Target
 *               server (`sshHost`); it has no fixed destination.
 * `credentialId` and `sshHost` are required for every type; `sshPort` / `bindHost`
 * are optional (defaulted in the resolver), and `entryAddress` / `exitAddress` are
 * the verbatim strings the editor round-trips (local only).
 *
 * @param {*} def
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
export function validateDefinition(def) {
  const errors = {};

  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return { valid: false, errors: { _: "definition must be an object" } };
  }

  const type = normaliseTunnelType(def.type);
  if (def.type !== undefined && !TUNNEL_TYPES.includes(def.type)) {
    errors.type = `type must be one of ${TUNNEL_TYPES.join(", ")}`;
  }

  if (!isNonEmptyString(def.name)) {
    errors.name = "name is required";
  }
  // The local listener port — for `local` (the forwarded port) and `dynamic` (the
  // SOCKS port). A `remote` tunnel binds no local port, so it isn't required there.
  if (type !== "remote" && !isValidPort(def.localPort)) {
    errors.localPort = `localPort must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }
  if (def.bindHost !== undefined && !isNonEmptyString(def.bindHost)) {
    errors.bindHost = "bindHost must be a non-empty string when set";
  }

  // Destination — for `local` it's the Exit exposed locally; for `remote` it's the
  // local target the remote port forwards back to. `dynamic` has no fixed one.
  if (type !== "dynamic") {
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
  }

  // Remote bind — the port bound on the SSH server (`remote` only). Its host is
  // optional (the resolver defaults it to loopback; a non-loopback bind is the
  // warned GatewayPorts opt-in).
  if (type === "remote") {
    if (!def.remoteBind || typeof def.remoteBind !== "object") {
      errors.remoteBind = "remote bind is required";
    } else {
      if (
        def.remoteBind.host !== undefined &&
        !isNonEmptyString(def.remoteBind.host)
      ) {
        errors["remoteBind.host"] =
          "remote bind host must be a non-empty string when set";
      }
      if (!isValidPort(def.remoteBind.port)) {
        errors["remoteBind.port"] =
          `remote bind port must be an integer ${MIN_PORT}–${MAX_PORT}`;
      }
    }
  }

  // Target server — the SSH server the tunnel connects to. Mandatory for every
  // type (it is the far/exit end); its port defaults to 22 in the resolver.
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
export function validateCredential(cred) {
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
export function validateJumpHost(jump) {
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
