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

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEntry, parseTarget, parseExit, portInRange } from "../address.js";

test("portInRange bounds", () => {
  assert.equal(portInRange(1), true);
  assert.equal(portInRange(65535), true);
  assert.equal(portInRange(0), false);
  assert.equal(portInRange(65536), false);
  assert.equal(portInRange(80.5), false);
  assert.equal(portInRange("80"), false);
});

test("parseEntry: a bare port assumes loopback", () => {
  assert.deepEqual(parseEntry("5432"), { host: "127.0.0.1", port: 5432 });
  assert.deepEqual(parseEntry("  5432 "), { host: "127.0.0.1", port: 5432 });
});

test("parseEntry: address:port keeps the given host", () => {
  assert.deepEqual(parseEntry("0.0.0.0:80"), { host: "0.0.0.0", port: 80 });
  assert.deepEqual(parseEntry("localhost:8080"), {
    host: "localhost",
    port: 8080,
  });
  assert.deepEqual(parseEntry(":5432"), { host: "127.0.0.1", port: 5432 });
});

test("parseEntry: errors", () => {
  assert.deepEqual(parseEntry(""), { error: "empty" });
  assert.deepEqual(parseEntry("   "), { error: "empty" });
  assert.deepEqual(parseEntry("db.internal"), { error: "no_port" });
  assert.deepEqual(parseEntry("70000"), { error: "port_range" });
  assert.deepEqual(parseEntry("127.0.0.1:0"), { error: "port_range" });
});

test("parseTarget: host mandatory, port optional", () => {
  assert.deepEqual(parseTarget("bastion"), { host: "bastion" });
  assert.deepEqual(parseTarget("bastion:2222"), {
    host: "bastion",
    port: 2222,
  });
  assert.deepEqual(parseTarget("10.0.0.9"), { host: "10.0.0.9" });
});

test("parseTarget: errors", () => {
  assert.deepEqual(parseTarget(""), { error: "empty" });
  assert.deepEqual(parseTarget(":22"), { error: "empty" });
  assert.deepEqual(parseTarget("bastion:99999"), { error: "port_range" });
});

test("parseExit: blank means defer to caller", () => {
  assert.deepEqual(parseExit(""), {});
  assert.deepEqual(parseExit("   "), {});
});

test("parseExit: a bare port assumes loopback", () => {
  assert.deepEqual(parseExit("5432"), { host: "127.0.0.1", port: 5432 });
});

test("parseExit: a bare host defers its port", () => {
  assert.deepEqual(parseExit("db.local"), { host: "db.local" });
});

test("parseExit: address:port", () => {
  assert.deepEqual(parseExit("127.0.0.1:5432"), {
    host: "127.0.0.1",
    port: 5432,
  });
  assert.deepEqual(parseExit(":5432"), { host: "127.0.0.1", port: 5432 });
});

test("parseExit: port range error", () => {
  assert.deepEqual(parseExit("0"), { error: "port_range" });
  assert.deepEqual(parseExit("db.local:70000"), { error: "port_range" });
});

test("a non-numeric trailing colon segment is kept as the host (IPv6/hostname)", () => {
  // "::1" — a bare IPv6 loopback literal: not split into host + port.
  assert.deepEqual(parseTarget("::1"), { host: "::1" });
});
