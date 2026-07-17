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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  readSsid,
  probeReachable,
  parseDarwinSsid,
  parseLinuxSsid,
  parseWindowsSsid,
} = require("../network-info");

// ── SSID parsers (against captured CLI fixtures) ──────────────────────────────

test("parseDarwinSsid reads the associated network, else null", () => {
  assert.equal(
    parseDarwinSsid("Current Wi-Fi Network: Home Net 5G\n"),
    "Home Net 5G",
  );
  assert.equal(
    parseDarwinSsid("You are not associated with an AirPort network.\n"),
    null,
  );
  assert.equal(parseDarwinSsid("en0 is not a Wi-Fi interface.\n"), null);
  assert.equal(parseDarwinSsid(""), null);
});

test("parseLinuxSsid picks the active nmcli line and unescapes colons", () => {
  assert.equal(
    parseLinuxSsid("no:Neighbour\nyes:HomeNet\nno:Other\n"),
    "HomeNet",
  );
  assert.equal(parseLinuxSsid("yes:Cafe\\:Wifi\n"), "Cafe:Wifi");
  assert.equal(parseLinuxSsid("no:Only\nno:Networks\n"), null);
  assert.equal(parseLinuxSsid(""), null);
});

test("parseWindowsSsid reads SSID but not the BSSID line", () => {
  const netsh = [
    "There is 1 interface on the system:",
    "",
    "    Name                   : Wi-Fi",
    "    State                  : connected",
    "    SSID                   : Office WLAN",
    "    BSSID                  : a0:b1:c2:d3:e4:f5",
    "    Signal                 : 92%",
    "",
  ].join("\n");
  assert.equal(parseWindowsSsid(netsh), "Office WLAN");
  assert.equal(
    parseWindowsSsid("    BSSID                  : a0:b1:c2:d3:e4:f5\n"),
    null,
  );
  assert.equal(parseWindowsSsid("no interfaces\n"), null);
});

// ── readSsid (best-effort, graceful) ──────────────────────────────────────────

test("readSsid returns ok + name when the tool succeeds", async () => {
  const exec = (_cmd, _args, _opts, cb) =>
    cb(null, "Current Wi-Fi Network: HomeNet\n", "");
  assert.deepEqual(await readSsid({ platform: "darwin", exec }), {
    ssid: "HomeNet",
    status: "ok",
  });
});

test("readSsid returns ok + null when the tool runs but reports no network", async () => {
  const exec = (_cmd, _args, _opts, cb) =>
    cb(null, "You are not associated with an AirPort network.\n", "");
  assert.deepEqual(await readSsid({ platform: "darwin", exec }), {
    ssid: null,
    status: "ok",
  });
});

test("readSsid returns unknown when the tool errors (missing / non-zero)", async () => {
  const exec = (_cmd, _args, _opts, cb) => cb(new Error("ENOENT"));
  assert.deepEqual(await readSsid({ platform: "linux", exec }), {
    ssid: null,
    status: "unknown",
  });
});

test("readSsid returns unknown on an unsupported platform (no tool invoked)", async () => {
  let called = false;
  const exec = () => {
    called = true;
  };
  assert.deepEqual(await readSsid({ platform: "sunos", exec }), {
    ssid: null,
    status: "unknown",
  });
  assert.equal(called, false);
});

// ── probeReachable (read-only TCP connect) ────────────────────────────────────

/** A fake socket that lets a test drive connect/error/timeout deterministically. */
function fakeSocket() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = () => {
    s.destroyed = true;
  };
  s.unref = () => {};
  return s;
}

test("probeReachable resolves true when the connection is established", async () => {
  const socket = fakeSocket();
  const connect = (_opts, onConnect) => {
    setImmediate(onConnect);
    return socket;
  };
  assert.equal(await probeReachable("10.0.0.1", 22, { connect }), true);
  assert.equal(socket.destroyed, true); // disposed, never read from
});

test("probeReachable resolves false on a connection error", async () => {
  const connect = () => {
    const socket = fakeSocket();
    setImmediate(() => socket.emit("error", new Error("ECONNREFUSED")));
    return socket;
  };
  assert.equal(await probeReachable("10.0.0.1", 22, { connect }), false);
});

test("probeReachable resolves false on timeout without connecting", async () => {
  const connect = () => fakeSocket(); // never connects, never errors
  assert.equal(
    await probeReachable("10.0.0.1", 22, { connect, timeout: 20 }),
    false,
  );
});

test("probeReachable rejects malformed host/port without opening a socket", async () => {
  let called = false;
  const connect = () => {
    called = true;
    return fakeSocket();
  };
  assert.equal(await probeReachable("", 22, { connect }), false);
  assert.equal(await probeReachable("h", 0, { connect }), false);
  assert.equal(await probeReachable("h", 70000, { connect }), false);
  assert.equal(called, false);
});
