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
 * resolve.js — the single place every tunnel default / implication lives (the
 * "resolver seam").
 *
 * `resolveDefinition` turns a stored reference-shape tunnel plus its referenced
 * (already-decrypted) credential and jump-host records into the self-contained,
 * engine-shaped definition the Feature 20 tunnel engine consumes
 * (`{ destination, sshServer, jumps }` with each hop carrying an `auth[]`). Doing
 * the resolution here means the engine, ssh-chain and relay code are untouched by
 * Feature 45 — they still receive exactly the shape they always have.
 *
 * The implication rules (a single source of truth):
 *   - localHost binding defaults to 127.0.0.1 (`bindHost`); LAN exposure is opt-in.
 *   - sshPort defaults to 22.
 *   - a BLANK sshHost means "the SSH server is the destination box itself": SSH to
 *     the destination host and forward to 127.0.0.1:destPort on it.
 *   - a NON-BLANK sshHost means a bastion forwards onward: SSH to that host and
 *     forward to destHost:destPort as resolved from the bastion.
 *
 * `summariseRoute` reuses the same blank-sshHost implication to build the compact
 * route string shown on each Definition list row, so the display and the actual
 * connection can never drift.
 *
 * Pure — no I/O, no crypto. Callers pass already-decrypted credentials.
 */
"use strict";

const { normaliseTunnelType } = require("./validate");

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_SSH_PORT = 22;
const LOOPBACK = "127.0.0.1";

function isBlank(v) {
  return typeof v !== "string" || v.trim() === "";
}

/**
 * Map a decrypted credential to a single engine auth entry
 * (`{ type, privateKeyPath?, passphrase?|password?, decryptError? }`). A missing
 * credential yields no entry (the caller renders an empty `auth[]`, which the
 * engine fails cleanly on) so a dangling reference fails closed, never silently.
 *
 * @param {object|undefined} cred  a DECRYPTED credential record
 * @returns {object[]}  a zero- or one-element auth array
 */
function credentialToAuth(cred) {
  if (!cred || typeof cred !== "object") return [];
  const entry = { type: cred.authType };
  if (cred.authType === "key") {
    entry.privateKeyPath = cred.keyPath || "";
    if (typeof cred.passphrase === "string" && cred.passphrase.length > 0) {
      entry.passphrase = cred.passphrase;
    }
  } else if (cred.authType === "password") {
    if (typeof cred.password === "string" && cred.password.length > 0) {
      entry.password = cred.password;
    }
  }
  if (cred.decryptError) entry.decryptError = cred.decryptError;
  return [entry];
}

/** Build one engine hop `{ host, port, user, auth }` from a host + credential. */
function hop(host, port, cred) {
  return {
    host: host || "",
    port: Number.isInteger(port) ? port : DEFAULT_SSH_PORT,
    user: (cred && cred.user) || "",
    auth: credentialToAuth(cred),
  };
}

/**
 * Resolve a stored tunnel + its referenced records into an engine definition.
 *
 * @param {object} tunnel  the reference-shape stored tunnel
 * @param {object} refs
 * @param {Map<string,object>|Object<string,object>} refs.credentialsById  DECRYPTED credentials
 * @param {Map<string,object>|Object<string,object>} refs.jumpHostsById     jump-host records
 * @returns {object}  engine-shaped definition
 */
function resolveDefinition(tunnel, { credentialsById, jumpHostsById } = {}) {
  const t = tunnel || {};
  const type = normaliseTunnelType(t.type);
  const creds = asGetter(credentialsById);
  const jumps = asGetter(jumpHostsById);
  const sshPort = Number.isInteger(t.sshPort) ? t.sshPort : DEFAULT_SSH_PORT;

  const jumpHops = (Array.isArray(t.jumpHostIds) ? t.jumpHostIds : []).map(
    (id) => {
      const jh = jumps(id);
      // A missing jump host fails closed (empty host + no auth → the chain
      // errors) rather than silently bypassing a required bastion.
      if (!jh) return { host: "", port: DEFAULT_SSH_PORT, user: "", auth: [] };
      return hop(jh.host, jh.port, creds(jh.credentialId));
    },
  );

  // Fields common to every forwarding type.
  const base = {
    id: t.id,
    name: t.name,
    type,
    enabled: t.enabled,
    keepAlive: t.keepAlive,
    autoReconnect: t.autoReconnect,
    lingerMs: t.lingerMs,
    // Feature 130: the optional per-tunnel reconnect-policy override, read live
    // by the engine (like lingerMs / autoReconnect). Undefined ⇒ inherit settings.
    retry: t.retry,
    bindHost: t.bindHost || DEFAULT_BIND_HOST,
    jumps: jumpHops,
  };

  if (type === "dynamic") {
    // A local SOCKS listener; SSH to the (mandatory) target server, which is the
    // exit vantage. There is no fixed destination — each SOCKS request names it.
    return {
      ...base,
      localPort: t.localPort,
      destination: null,
      sshServer: hop(t.sshHost, sshPort, creds(t.credentialId)),
    };
  }

  if (type === "remote") {
    // SSH to the target server and bind `remoteBind` there; each accepted remote
    // connection is forwarded back to the local `destination` target. The remote
    // bind host defaults to loopback (a non-loopback bind needs server GatewayPorts).
    const remoteBind = {
      host: isBlank(t.remoteBind?.host) ? LOOPBACK : t.remoteBind.host,
      port: t.remoteBind?.port,
    };
    const destination = {
      host: isBlank(t.destination?.host) ? LOOPBACK : t.destination.host,
      port: t.destination?.port,
    };
    return {
      ...base,
      remoteBind,
      destination,
      sshServer: hop(t.sshHost, sshPort, creds(t.credentialId)),
    };
  }

  // local (default) — bind `bindHost:localPort` and forward it to the Exit.
  const destHost = t.destination?.host;
  const destPort = t.destination?.port;
  // A blank sshHost means "the SSH server is the destination box itself" — a
  // backward-compatible shape for tunnels migrated before Feature 45 set sshHost
  // explicitly. New tunnels always carry sshHost.
  const sshImplied = isBlank(t.sshHost);
  const sshHost = sshImplied ? destHost : t.sshHost;

  return {
    ...base,
    localPort: t.localPort,
    destination: { host: sshImplied ? LOOPBACK : destHost, port: destPort },
    sshServer: hop(sshHost, sshPort, creds(t.credentialId)),
  };
}

/**
 * Build the compact route string for a Definition list row, reusing the same
 * implications as the resolver so display and behaviour can't drift. The shape
 * depends on the forwarding type (Feature 110):
 *
 *   local    :5432 → db.example.com:5432
 *            :5432 → db.internal:5432  via bastion  (jump: relay1, relay2)
 *   remote   R bastion:8080 → 127.0.0.1:3000
 *   dynamic  SOCKS5 :1080  via bastion
 *
 * @param {object} tunnel
 * @param {object} [refs]
 * @param {Map<string,object>|Object<string,object>} [refs.jumpHostsById]  for labels
 * @returns {string}
 */
function summariseRoute(tunnel, { jumpHostsById } = {}) {
  const t = tunnel || {};
  const type = normaliseTunnelType(t.type);
  const jumps = asGetter(jumpHostsById);

  const jumpSuffix = () => {
    const ids = Array.isArray(t.jumpHostIds) ? t.jumpHostIds : [];
    if (ids.length === 0) return "";
    const labels = ids.map((id) => jumps(id)?.label || id);
    return `  (jump: ${labels.join(", ")})`;
  };

  if (type === "dynamic") {
    let out = `SOCKS5 :${t.localPort ?? "?"}`;
    if (!isBlank(t.sshHost)) out += `  via ${t.sshHost}`;
    return out + jumpSuffix();
  }

  if (type === "remote") {
    const server = isBlank(t.sshHost) ? "?" : t.sshHost;
    const rPort = t.remoteBind?.port ?? "?";
    const dHost = t.destination?.host || LOOPBACK;
    const dPort = t.destination?.port ?? "?";
    return `R ${server}:${rPort} → ${dHost}:${dPort}` + jumpSuffix();
  }

  // local
  const destHost = t.destination?.host || "?";
  const destPort = t.destination?.port ?? "?";
  let out = `:${t.localPort ?? "?"} → ${destHost}:${destPort}`;
  if (!isBlank(t.sshHost)) out += `  via ${t.sshHost}`;
  return out + jumpSuffix();
}

/** Accept either a Map or a plain object index and return a `(id) => record`. */
function asGetter(index) {
  if (index instanceof Map) return (id) => index.get(id);
  if (index && typeof index === "object") return (id) => index[id];
  return () => undefined;
}

module.exports = { resolveDefinition, summariseRoute, credentialToAuth };
