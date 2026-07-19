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
const TUNNEL_TYPES = ["local", "remote", "dynamic"];

/**
 * The fixed group-colour palette (Feature 140). A group's `color` is one of these
 * theme-token KEYS — never a hardcoded hex — so it stays legible in light/dark and
 * matches the design system. Each maps to a `--color-group-<key>` token in
 * theme.css. Deliberately distinct from the four status hues so a group tag never
 * reads as a tunnel status signal.
 */
const GROUP_COLORS = ["blue", "teal", "green", "amber", "violet", "red"];

/** The default colour a freshly created group takes when none is chosen. */
const DEFAULT_GROUP_COLOR = GROUP_COLORS[0];

/** Normalise a possibly-absent `type` to one of TUNNEL_TYPES (default local). */
function normaliseTunnelType(type) {
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

// ── Schedule (Feature 150) ────────────────────────────────────────────────────
// An optional `schedule` may ride a tunnel OR a group: a time window and/or a
// network condition, ANDed together, each independently optional (absent ⇒ not a
// constraint). Validated identically on both record types so a rule authored on
// either is held to the same shape.
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A "HH:MM" 24-hour wall-clock string. */
function isTimeOfDay(v) {
  return typeof v === "string" && TIME_OF_DAY_RE.test(v);
}

/** A day-of-week index (0 = Sunday … 6 = Saturday). */
function isWeekday(v) {
  return Number.isInteger(v) && v >= 0 && v <= 6;
}

/**
 * Validate an optional `schedule`, writing dotted errors under `prefix` (e.g.
 * `schedule.time.days`, `schedule.network.reach.port`). Absent is always valid
 * (no schedule). A present `time` needs a non-empty day list plus a start/end
 * pair of distinct HH:MM strings (a window that wraps past midnight is fine, so
 * only `start === end` is rejected). A present `network` may carry an SSID
 * allow-list and/or a reachability `host:port`; each is optional but must be
 * well-formed when given.
 *
 * @param {Object<string,string>} errors  accumulator to write into
 * @param {*} schedule
 * @param {string} prefix
 */
function collectScheduleErrors(errors, schedule, prefix) {
  if (schedule === undefined) return;
  if (
    schedule === null ||
    typeof schedule !== "object" ||
    Array.isArray(schedule)
  ) {
    errors[prefix] = "schedule must be an object when set";
    return;
  }

  const { time, network } = schedule;

  if (time !== undefined) {
    if (time === null || typeof time !== "object" || Array.isArray(time)) {
      errors[`${prefix}.time`] = "time must be an object when set";
    } else {
      if (!Array.isArray(time.days) || time.days.length === 0) {
        errors[`${prefix}.time.days`] = "select at least one day";
      } else if (!time.days.every(isWeekday)) {
        errors[`${prefix}.time.days`] = "days must be integers 0–6";
      }
      if (!isTimeOfDay(time.start)) {
        errors[`${prefix}.time.start`] = "start must be HH:MM (24-hour)";
      }
      if (!isTimeOfDay(time.end)) {
        errors[`${prefix}.time.end`] = "end must be HH:MM (24-hour)";
      }
      if (
        isTimeOfDay(time.start) &&
        isTimeOfDay(time.end) &&
        time.start === time.end
      ) {
        errors[`${prefix}.time.end`] = "end must differ from start";
      }
    }
  }

  if (network !== undefined) {
    if (
      network === null ||
      typeof network !== "object" ||
      Array.isArray(network)
    ) {
      errors[`${prefix}.network`] = "network must be an object when set";
    } else {
      if (network.ssids !== undefined) {
        if (!Array.isArray(network.ssids)) {
          errors[`${prefix}.network.ssids`] = "ssids must be an array when set";
        } else if (!network.ssids.every(isNonEmptyString)) {
          errors[`${prefix}.network.ssids`] =
            "each SSID must be a non-empty string";
        }
      }
      if (network.reach !== undefined) {
        if (
          network.reach === null ||
          typeof network.reach !== "object" ||
          Array.isArray(network.reach)
        ) {
          errors[`${prefix}.network.reach`] =
            "reach must be an object when set";
        } else {
          if (!isNonEmptyString(network.reach.host)) {
            errors[`${prefix}.network.reach.host`] = "reach host is required";
          }
          if (!isValidPort(network.reach.port)) {
            errors[`${prefix}.network.reach.port`] =
              `reach port must be an integer ${MIN_PORT}–${MAX_PORT}`;
          }
        }
      }
    }
  }
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
function validateDefinition(def) {
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

  // Optional group membership (Feature 140): a tunnel belongs to zero or one group.
  // Absent / null means ungrouped; a present value must be a non-empty id string.
  // Existence of the referenced group is a store-level concern (see _assertRefs).
  if (
    def.groupId !== undefined &&
    def.groupId !== null &&
    !isNonEmptyString(def.groupId)
  ) {
    errors.groupId = "groupId must be a non-empty string when set";
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

  // Optional per-tunnel reconnect-policy override (Feature 130). Any field left
  // out inherits the global setting; each present field must be a sane integer.
  if (def.retry !== undefined) {
    if (
      def.retry === null ||
      typeof def.retry !== "object" ||
      Array.isArray(def.retry)
    ) {
      errors.retry = "retry must be an object when set";
    } else {
      const posInt = (v) => Number.isInteger(v) && v >= 1;
      if (def.retry.baseMs !== undefined && !posInt(def.retry.baseMs)) {
        errors["retry.baseMs"] = "retry.baseMs must be an integer ≥ 1";
      }
      if (def.retry.maxMs !== undefined && !posInt(def.retry.maxMs)) {
        errors["retry.maxMs"] = "retry.maxMs must be an integer ≥ 1";
      }
      if (
        def.retry.maxAttempts !== undefined &&
        !(Number.isInteger(def.retry.maxAttempts) && def.retry.maxAttempts >= 0)
      ) {
        errors["retry.maxAttempts"] =
          "retry.maxAttempts must be an integer ≥ 0";
      }
    }
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

  // Optional scheduling rule (Feature 150): a time window and/or network trigger.
  collectScheduleErrors(errors, def.schedule, "schedule");

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

/**
 * Validate a reusable group record (Feature 140). A group is purely
 * organisational: a required `label` and a `color` chosen from the fixed
 * GROUP_COLORS token palette. Order is array position (never a stored field), so
 * it isn't validated here.
 *
 * @param {*} group
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
function validateGroup(group) {
  const errors = {};

  if (!group || typeof group !== "object" || Array.isArray(group)) {
    return { valid: false, errors: { _: "group must be an object" } };
  }

  if (!isNonEmptyString(group.label)) {
    errors.label = "label is required";
  }
  if (!GROUP_COLORS.includes(group.color)) {
    errors.color = `color must be one of ${GROUP_COLORS.join(", ")}`;
  }

  // A group may carry a scheduling rule its members inherit (Feature 150).
  collectScheduleErrors(errors, group.schedule, "schedule");

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validate a console definition (Feature 200) — a reusable interactive-shell
 * target. A console is a much simpler reference record than a tunnel: it has no
 * local port, destination, forwarding type or linger — only a required `name`, a
 * `sshHost` (the target server, its `sshPort` optional and defaulted to 22 in the
 * resolver), a `credentialId`, and an optional ordered `jumpHostIds` chain. It
 * reuses the same credential + jump-host pools tunnels do; referential integrity
 * (does a referenced id exist?) is a store-level concern (see console-store's
 * _assertRefs), so only structure is checked here.
 *
 * @param {*} def
 * @returns {{ valid: boolean, errors: Object<string,string> }}
 */
function validateConsole(def) {
  const errors = {};

  if (!def || typeof def !== "object" || Array.isArray(def)) {
    return { valid: false, errors: { _: "console must be an object" } };
  }

  if (!isNonEmptyString(def.name)) {
    errors.name = "name is required";
  }
  if (!isNonEmptyString(def.sshHost)) {
    errors.sshHost = "target server is required";
  }
  if (def.sshPort !== undefined && !isValidPort(def.sshPort)) {
    errors.sshPort = `sshPort must be an integer ${MIN_PORT}–${MAX_PORT}`;
  }
  if (!isNonEmptyString(def.credentialId)) {
    errors.credentialId = "a credential is required";
  }

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

  return { valid: Object.keys(errors).length === 0, errors };
}

module.exports = {
  AUTH_TYPES,
  TUNNEL_TYPES,
  GROUP_COLORS,
  DEFAULT_GROUP_COLOR,
  normaliseTunnelType,
  secretFieldForAuthType,
  validateDefinition,
  validateCredential,
  validateJumpHost,
  validateGroup,
  validateConsole,
};
