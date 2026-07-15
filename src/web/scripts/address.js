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

// address.js — pure parsers for the tunnel editor's three address:port fields
// (Entry / Target / Exit). Each accepts a flexible free-text value and returns
// the extracted `{ host?, port? }` or `{ error }` (a machine code the editor maps
// to an i18n message). No DOM, no i18n, no I/O — trivially unit-testable, and the
// single source of truth for how each field is split and defaulted.
//
// The three fields differ only in their defaulting rules:
//   - Entry  — a bare port assumes 127.0.0.1; a host WITHOUT a port is an error
//              (the entry point must name a port to bind).
//   - Target — a host is mandatory; the port is optional (the caller defaults it
//              to the SSH port, 22).
//   - Exit   — everything is optional; blank means "loopback + the entry port".
//              A bare port assumes 127.0.0.1; a bare host defers its port to the
//              caller (which fills in the entry port).
//
// Splitting rule: the trailing `:NNN` segment is treated as a port ONLY when it
// is all digits, so a bare IPv6 literal (multiple colons, non-numeric tail) or a
// hostname with a stray colon is kept whole as the host rather than mis-split.

const MIN_PORT = 1;
const MAX_PORT = 65535;
/** Ports below this generally require elevated privileges to bind. */
export const PRIVILEGED_PORT = 1024;
/** The implicit local address when a field names only a port. */
export const LOOPBACK = "127.0.0.1";

/** True when `n` is an integer inside the bindable port range. */
export function portInRange(n) {
  return Number.isInteger(n) && n >= MIN_PORT && n <= MAX_PORT;
}

function isAllDigits(s) {
  return /^\d+$/.test(s);
}

/**
 * Split a trimmed `host:port` value into host + (string) port. A bare IPv6
 * literal keeps its colons: brackets carry the port (`[::1]:22`), and an
 * unbracketed value with more than one colon is treated as a whole host with no
 * port. Only a single trailing `:NNN` (all digits) is peeled off as the port.
 * `host` may come back empty (e.g. ":5432" → port only).
 *
 * @param {string} s  already-trimmed input
 * @returns {{ host: string, portStr: string }}
 */
function splitHostPort(s) {
  // Bracketed IPv6: "[::1]" or "[::1]:port".
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end !== -1) {
      const host = s.slice(1, end);
      const rest = s.slice(end + 1);
      if (rest === "") return { host, portStr: "" };
      if (rest.startsWith(":") && isAllDigits(rest.slice(1))) {
        return { host, portStr: rest.slice(1) };
      }
      return { host: s, portStr: "" }; // malformed → keep whole as host
    }
  }
  const last = s.lastIndexOf(":");
  if (last === -1) return { host: s, portStr: "" };
  // More than one colon (unbracketed) → a bare IPv6 literal, not host:port.
  if (s.indexOf(":") !== last) return { host: s, portStr: "" };
  const portStr = s.slice(last + 1);
  if (portStr !== "" && isAllDigits(portStr)) {
    return { host: s.slice(0, last), portStr };
  }
  return { host: s, portStr: "" };
}

/**
 * Parse the Entry-port field: the local address the tunnel listens on.
 *   ""            → { error: "empty" }
 *   "5432"        → { host: "127.0.0.1", port: 5432 }
 *   "0.0.0.0:80"  → { host: "0.0.0.0", port: 80 }
 *   "db.internal" → { error: "no_port" }  (a host must name a port)
 *
 * @param {string} raw
 * @returns {{ host: string, port: number } | { error: string }}
 */
export function parseEntry(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { error: "empty" };
  if (isAllDigits(s)) {
    const port = Number(s);
    return portInRange(port)
      ? { host: LOOPBACK, port }
      : { error: "port_range" };
  }
  const { host, portStr } = splitHostPort(s);
  if (portStr === "") return { error: "no_port" };
  const port = Number(portStr);
  if (!portInRange(port)) return { error: "port_range" };
  return { host: host.trim() === "" ? LOOPBACK : host.trim(), port };
}

/**
 * Parse the Target-server field: the remote SSH server the tunnel connects to.
 * The host is mandatory; the port is optional (caller defaults to 22).
 *   ""              → { error: "empty" }
 *   "bastion"       → { host: "bastion" }
 *   "bastion:2222"  → { host: "bastion", port: 2222 }
 *   ":22"           → { error: "empty" }  (no host)
 *
 * @param {string} raw
 * @returns {{ host: string, port?: number } | { error: string }}
 */
export function parseTarget(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { error: "empty" };
  const { host, portStr } = splitHostPort(s);
  const h = host.trim();
  if (h === "") return { error: "empty" };
  if (portStr === "") return { host: h };
  const port = Number(portStr);
  if (!portInRange(port)) return { error: "port_range" };
  return { host: h, port };
}

/**
 * Parse the Exit-port field: the address on the target server the tunnel
 * forwards to. Everything is optional; the caller fills the missing host with
 * 127.0.0.1 and the missing port with the entry port.
 *   ""            → {}
 *   "5432"        → { host: "127.0.0.1", port: 5432 }
 *   "127.0.0.1:5432" → { host: "127.0.0.1", port: 5432 }
 *   "db.local"    → { host: "db.local" }  (port deferred to the caller)
 *
 * @param {string} raw
 * @returns {{ host?: string, port?: number } | { error: string }}
 */
export function parseExit(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return {};
  if (isAllDigits(s)) {
    const port = Number(s);
    return portInRange(port)
      ? { host: LOOPBACK, port }
      : { error: "port_range" };
  }
  const { host, portStr } = splitHostPort(s);
  const h = host.trim();
  if (portStr === "") return h === "" ? {} : { host: h };
  const port = Number(portStr);
  if (!portInRange(port)) return { error: "port_range" };
  return { host: h === "" ? LOOPBACK : h, port };
}
