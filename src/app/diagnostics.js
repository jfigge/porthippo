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
 * diagnostics.js — build the plain-text "copy diagnostics" report (versions,
 * platform, a redacted tunnel summary, and a tail of the rotating log). Pure and
 * dependency-free: the caller (main.js) injects the app metadata, the sealed
 * tunnel list, and the already-read log files, which is what makes it unit
 * testable and keeps it off the filesystem.
 *
 * SECURITY — two layers, so a report can NEVER carry a secret:
 *   1. Containment. The tunnel summary is built from the store's SEALED list
 *      (`tunnelStore().list()`), which returns a `hasSecret` boolean per auth
 *      method and never a password/passphrase/key value. Auth is reported as a
 *      list of method *types* only — never key-file paths (which can leak
 *      usernames/home directories).
 *   2. Redaction. The log tail is passed through `redact()` as defense in depth —
 *      even though secrets are never logged, we scrub PEM private-key blocks,
 *      `password:`/`passphrase:`-style key/values, and inline `user:pass@host`
 *      URL credentials before they can reach the clipboard. Covered by
 *      tests/diagnostics.test.js.
 */
"use strict";

const REDACTED = "[redacted]";

/**
 * Scrub anything secret-shaped from free text (a log tail). Best-effort defense
 * in depth — the sources feeding the report are already secret-free.
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  if (!text) return "";
  let out = String(text);

  // PEM private-key blocks (OpenSSH / PKCS#8 / RSA / EC …).
  out = out.replace(
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
    "[redacted private key]",
  );

  // key: value / key = "value" pairs whose key names a secret.
  out = out.replace(
    /("?\b(?:password|passphrase|secret|token|privatekey|private_key)\b"?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, head) => `${head}${REDACTED}`,
  );

  // Inline URL credentials: scheme://user:pass@host → scheme://user:[redacted]@host
  out = out.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi,
    (_m, head, _pass, at) => `${head}${REDACTED}${at}`,
  );

  return out;
}

/**
 * Summarize one SEALED tunnel definition to a single secret-free line. Accepts
 * the shape returned by `tunnelStore().list()` (secrets already stripped).
 * @param {object} def
 * @returns {string}
 */
function summarizeTunnel(def) {
  const d = def || {};
  const name = d.name || "(unnamed)";
  const dest = d.destination || {};
  const server = d.sshServer || {};
  const jumps = Array.isArray(d.jumps) ? d.jumps.length : 0;

  // Auth is reported as method TYPES only (agent/key/password) — never values or
  // key-file paths. Collect across the SSH server + every jump hop.
  const types = new Set();
  const collect = (hop) => {
    for (const a of (hop && hop.auth) || []) if (a && a.type) types.add(a.type);
  };
  collect(server);
  for (const j of d.jumps || []) collect(j);

  const authList = types.size ? [...types].join("/") : "none";
  return (
    `- ${name}: local :${d.localPort ?? "?"} → ${dest.host ?? "?"}:${
      dest.port ?? "?"
    } via ${server.host ?? "?"}:${server.port ?? "?"}` +
    ` (jumps: ${jumps}, auth: ${authList}, enabled: ${d.enabled ? "yes" : "no"})`
  );
}

/**
 * Build the full diagnostics report as a string.
 * @param {object} opts
 * @param {Object<string,string|number>} [opts.app]  version/platform metadata
 * @param {Array<object>} [opts.tunnels]  SEALED tunnel definitions
 * @param {Array<{name:string,content:string}>} [opts.logs]  oldest-first
 * @param {string} [opts.generatedAt]  ISO timestamp (injected; kept out of here)
 * @returns {string}
 */
function buildReport({ app = {}, tunnels = [], logs = [], generatedAt } = {}) {
  const lines = [];
  lines.push("Port Hippo diagnostics report");
  lines.push("=============================");
  if (generatedAt) lines.push(`generated: ${generatedAt}`);
  for (const [key, value] of Object.entries(app)) {
    lines.push(`${key}: ${value}`);
  }

  // ── Tunnels (secret-free summary) ──────────────────────────────────────────
  lines.push("");
  lines.push(`--- tunnels (${tunnels.length}) ---`);
  if (tunnels.length === 0) {
    lines.push("(none defined)");
  } else {
    for (const def of tunnels) lines.push(summarizeTunnel(def));
  }

  // ── Log tail (redacted) ────────────────────────────────────────────────────
  lines.push("");
  lines.push("--- logs ---");
  if (!logs || logs.length === 0) {
    lines.push("(no log files found)");
  } else {
    for (const file of logs) {
      lines.push(`----- ${file.name} -----`);
      const content = redact(file.content).replace(/\n+$/, "");
      lines.push(content.length ? content : "(empty)");
    }
  }

  return `${lines.join("\n")}\n`;
}

module.exports = { buildReport, redact, summarizeTunnel };
