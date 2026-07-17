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
 * network-info.js — a read-only seam for the two network signals the scheduler
 * (Feature 150) can gate a tunnel on: the current Wi-Fi SSID and whether a named
 * `host:port` is reachable.
 *
 * SSID is read with the platform's own tool (macOS `networksetup`, Linux `nmcli`,
 * Windows `netsh wlan`) behind an injectable `execFile`; each tool's output is
 * parsed by a small pure function that is unit-tested against captured CLI
 * fixtures — no real Wi-Fi needed. Every path is READ-ONLY and DEGRADES
 * GRACEFULLY: a missing tool, a non-zero exit, or an unparseable output resolves
 * to `{ ssid: null, status: "unknown" }` rather than throwing, and the scheduler
 * treats an `unknown` SSID as fail-safe (it never force-arms a tunnel it can't
 * confirm the network for).
 *
 * Reachability is a plain TCP `connect` probe — never a command run anywhere —
 * that resolves `true` on connect and `false` on any error/timeout, disposing the
 * socket immediately (it reads nothing off the wire).
 *
 * PRIVACY: nothing here logs an SSID, network name, or probe result. The values
 * flow only into the in-memory scheduler decision; they never reach the log or a
 * diagnostics report.
 */
"use strict";

const net = require("net");
const { execFile } = require("child_process");

// The SSID tool is time-boxed so a wedged CLI can't stall a re-evaluation; the
// reachability probe has its own, shorter default.
const SSID_CLI_TIMEOUT_MS = 4000;
const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const CLI_MAX_BUFFER = 1 << 20; // 1 MiB — CLI output is tiny; cap it defensively.

// ── SSID parsers (pure; exported for fixture tests) ───────────────────────────

/**
 * Parse `networksetup -getairportnetwork <iface>` output. It prints either
 * `Current Wi-Fi Network: <name>` when associated, or a "not associated" /
 * "not a Wi-Fi interface" line otherwise. Returns the SSID, or null.
 * @param {string} stdout
 * @returns {string|null}
 */
function parseDarwinSsid(stdout) {
  const m = /^Current Wi-Fi Network:\s*(.+?)\s*$/m.exec(String(stdout || ""));
  return m ? m[1] : null;
}

/**
 * Parse `nmcli -t -f active,ssid dev wifi` output: one `active:ssid` line per
 * visible network, the connected one prefixed `yes:`. nmcli's terse mode escapes
 * a literal colon in a field as `\:`. Returns the connected SSID, or null.
 * @param {string} stdout
 * @returns {string|null}
 */
function parseLinuxSsid(stdout) {
  for (const line of String(stdout || "").split("\n")) {
    if (!line.startsWith("yes:")) continue;
    const ssid = line.slice(4).replace(/\\:/g, ":").trim();
    return ssid || null;
  }
  return null;
}

/**
 * Parse `netsh wlan show interfaces` output: the connected interface reports a
 * `    SSID                   : <name>` line. Guards against the adjacent `BSSID`
 * line (whose label also ends in "SSID"). Returns the SSID, or null.
 * @param {string} stdout
 * @returns {string|null}
 */
function parseWindowsSsid(stdout) {
  for (const line of String(stdout || "").split("\n")) {
    const m = /^\s*SSID\s*:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1] || null;
  }
  return null;
}

// Per-platform SSID provider: the command to run + the parser for its output.
const SSID_PROVIDERS = {
  darwin: {
    cmd: "/usr/sbin/networksetup",
    args: ["-getairportnetwork", "en0"],
    parse: parseDarwinSsid,
  },
  linux: {
    cmd: "nmcli",
    args: ["-t", "-f", "active,ssid", "dev", "wifi"],
    parse: parseLinuxSsid,
  },
  win32: {
    cmd: "netsh",
    args: ["wlan", "show", "interfaces"],
    parse: parseWindowsSsid,
  },
};

/**
 * Read the current Wi-Fi SSID, best-effort and read-only.
 *
 * Resolves `{ ssid, status }`:
 *   - `{ ssid: "<name>", status: "ok" }`  associated with a named network;
 *   - `{ ssid: null, status: "ok" }`      the tool ran but we're on no Wi-Fi
 *                                          (wired / radio off / not associated);
 *   - `{ ssid: null, status: "unknown" }` the tool is missing, errored, or its
 *                                          output was unparseable — the scheduler
 *                                          treats this as fail-safe.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform]  defaults to process.platform
 * @param {Function} [deps.exec]    injectable execFile (for tests)
 * @param {number} [deps.timeout]
 * @returns {Promise<{ ssid: string|null, status: "ok"|"unknown" }>}
 */
function readSsid({
  platform = process.platform,
  exec = execFile,
  timeout = SSID_CLI_TIMEOUT_MS,
} = {}) {
  const provider = SSID_PROVIDERS[platform];
  if (!provider) return Promise.resolve({ ssid: null, status: "unknown" });

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      exec(
        provider.cmd,
        provider.args,
        { timeout, windowsHide: true, maxBuffer: CLI_MAX_BUFFER },
        (err, stdout) => {
          if (err) return done({ ssid: null, status: "unknown" });
          try {
            const ssid = provider.parse(stdout);
            done({ ssid: ssid || null, status: "ok" });
          } catch {
            done({ ssid: null, status: "unknown" });
          }
        },
      );
    } catch {
      done({ ssid: null, status: "unknown" });
    }
  });
}

/**
 * Probe whether `host:port` accepts a TCP connection right now. Read-only: it
 * opens a socket, resolves `true` the moment the connection is established (or
 * `false` on any error/timeout), and disposes the socket without reading or
 * writing a byte. Never runs a command anywhere.
 *
 * @param {string} host
 * @param {number} port
 * @param {object} [opts]
 * @param {number} [opts.timeout]
 * @param {Function} [opts.connect]  injectable net.connect (for tests)
 * @returns {Promise<boolean>}
 */
function probeReachable(
  host,
  port,
  { timeout = DEFAULT_PROBE_TIMEOUT_MS, connect = net.connect } = {},
) {
  return new Promise((resolve) => {
    const name = typeof host === "string" ? host.trim() : "";
    if (name === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false);
      return;
    }

    let settled = false;
    let socket = null;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket && socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };

    // The timer bounds the probe and resolves it; the socket itself is unref'd
    // (below) so a half-open connection never keeps the process alive on its own.
    timer = setTimeout(() => finish(false), timeout);

    try {
      socket = connect({ host: name, port }, () => finish(true));
      socket.on("error", () => finish(false));
      socket.unref?.(); // never keep the process alive for a probe
    } catch {
      finish(false);
    }
  });
}

module.exports = {
  readSsid,
  probeReachable,
  parseDarwinSsid,
  parseLinuxSsid,
  parseWindowsSsid,
};
