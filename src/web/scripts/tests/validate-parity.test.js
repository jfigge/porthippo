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

// validate-parity.test.js — the renderer's validators (web/scripts/validate.js)
// are a hand-kept copy of the authoritative store validators
// (app/store/validate.js). This guards against drift: both must return identical
// {valid, errors} for every fixture, and expose the same AUTH_TYPES /
// secretFieldForAuthType. If this fails, the two copies diverged — reconcile them.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as renderer from "../validate.js";
import main from "../../../app/store/validate.js"; // CJS module.exports (default)

const def = (over = {}) => ({
  name: "n",
  localPort: 8080,
  destination: { host: "d", port: 80 },
  credentialId: "cred-1",
  jumpHostIds: [],
  ...over,
});

const DEF_FIXTURES = [
  def(), // fully valid
  {}, // everything missing
  null,
  [],
  "not-an-object",
  def({ name: "" }),
  def({ name: undefined }),
  def({ localPort: 0 }),
  def({ localPort: 70000 }),
  def({ localPort: 3.5 }),
  def({ bindHost: "" }),
  def({ bindHost: 123 }),
  def({ bindHost: "0.0.0.0" }),
  def({ destination: undefined }),
  def({ destination: { host: "", port: 80 } }),
  def({ destination: { host: "d", port: -1 } }),
  def({ sshHost: "bastion", sshPort: 2222 }),
  def({ sshHost: "" }),
  def({ sshPort: 0 }),
  def({ sshPort: 70000 }),
  def({ credentialId: undefined }),
  def({ credentialId: "" }),
  def({ jumpHostIds: "nope" }),
  def({ jumpHostIds: ["a", "b"] }),
  def({ jumpHostIds: ["a", 5, ""] }),
  def({ lingerMs: -5 }),
  def({ lingerMs: 1.5 }),
  def({ lingerMs: 0 }),
  def({ keepAlive: "yes" }),
  def({ enabled: 1 }),
  def({ autoReconnect: "no" }),
  // Feature 130 — per-tunnel retry override bounds.
  def({ retry: { baseMs: 100, maxMs: 5000, maxAttempts: 5 } }),
  def({ retry: {} }),
  def({ retry: { maxAttempts: 0 } }),
  def({ retry: null }),
  def({ retry: [] }),
  def({ retry: "nope" }),
  def({ retry: { baseMs: 0 } }),
  def({ retry: { baseMs: 1.5 } }),
  def({ retry: { maxMs: -1 } }),
  def({ retry: { maxAttempts: -1 } }),
  def({ retry: { baseMs: 100, maxMs: "x", maxAttempts: 2 } }),
  // Feature 140 — optional group membership.
  def({ groupId: "g1" }),
  def({ groupId: null }),
  def({ groupId: "" }),
  def({ groupId: 5 }),
  // Feature 150 — optional scheduling rule (time window and/or network trigger).
  def({
    schedule: { time: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } },
  }),
  def({ schedule: { network: { ssids: ["Home"] } } }),
  def({ schedule: { network: { reach: { host: "10.0.0.1", port: 22 } } } }),
  def({
    schedule: {
      time: { days: [0, 6], start: "22:00", end: "06:00" },
      network: { ssids: ["Home", "Office"], reach: { host: "h", port: 443 } },
    },
  }),
  def({ schedule: null }),
  def({ schedule: [] }),
  def({ schedule: "nope" }),
  def({ schedule: {} }),
  def({ schedule: { time: {} } }),
  def({ schedule: { time: { days: [], start: "09:00", end: "17:00" } } }),
  def({ schedule: { time: { days: [7], start: "09:00", end: "17:00" } } }),
  def({ schedule: { time: { days: [1], start: "9:00", end: "17:00" } } }),
  def({ schedule: { time: { days: [1], start: "09:00", end: "09:00" } } }),
  def({ schedule: { time: { days: [1], start: "24:00", end: "17:00" } } }),
  def({ schedule: { network: { ssids: "Home" } } }),
  def({ schedule: { network: { ssids: [""] } } }),
  def({ schedule: { network: { reach: { host: "", port: 22 } } } }),
  def({ schedule: { network: { reach: { host: "h", port: 0 } } } }),
  def({ schedule: { network: { reach: null } } }),
];

const CRED_FIXTURES = [
  { label: "L", user: "u", authType: "agent" },
  { label: "L", user: "u", authType: "key", keyPath: "/k" },
  { label: "L", user: "u", authType: "key" },
  { label: "L", user: "u", authType: "password" },
  { label: "", user: "u", authType: "agent" },
  { label: "L", user: "", authType: "agent" },
  { label: "L", user: "u", authType: "totp" },
  {},
  null,
  [],
  "nope",
];

const JUMP_FIXTURES = [
  { label: "relay", host: "h", port: 22, credentialId: "cred-1" },
  { label: "", host: "h", port: 22, credentialId: "cred-1" },
  { label: "relay", host: "", port: 22, credentialId: "cred-1" },
  { label: "relay", host: "h", port: 0, credentialId: "cred-1" },
  { label: "relay", host: "h", port: 22, credentialId: "" },
  {},
  null,
  [],
];

const GROUP_FIXTURES = [
  { label: "Work", color: "blue" },
  { label: "Home", color: "teal" },
  { label: "", color: "blue" },
  { label: "Work", color: "#ff0000" },
  { label: "Work", color: undefined },
  { label: "Work" },
  {},
  null,
  [],
  "nope",
  // Feature 150 — a group may carry a schedule its members inherit.
  {
    label: "Work",
    color: "blue",
    schedule: { time: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } },
  },
  {
    label: "Work",
    color: "blue",
    schedule: { time: { days: [], start: "09:00", end: "17:00" } },
  },
  { label: "Work", color: "blue", schedule: "nope" },
  {
    label: "Work",
    color: "blue",
    schedule: { network: { reach: { host: "h", port: 70000 } } },
  },
];

test("renderer and store validateDefinition agree for every fixture", () => {
  DEF_FIXTURES.forEach((fixture, i) => {
    assert.deepEqual(
      renderer.validateDefinition(fixture),
      main.validateDefinition(fixture),
      `def fixture #${i} diverged: ${JSON.stringify(fixture)}`,
    );
  });
});

test("renderer and store validateCredential agree for every fixture", () => {
  CRED_FIXTURES.forEach((fixture, i) => {
    assert.deepEqual(
      renderer.validateCredential(fixture),
      main.validateCredential(fixture),
      `credential fixture #${i} diverged: ${JSON.stringify(fixture)}`,
    );
  });
});

test("renderer and store validateJumpHost agree for every fixture", () => {
  JUMP_FIXTURES.forEach((fixture, i) => {
    assert.deepEqual(
      renderer.validateJumpHost(fixture),
      main.validateJumpHost(fixture),
      `jump host fixture #${i} diverged: ${JSON.stringify(fixture)}`,
    );
  });
});

test("renderer and store validateGroup agree for every fixture", () => {
  GROUP_FIXTURES.forEach((fixture, i) => {
    assert.deepEqual(
      renderer.validateGroup(fixture),
      main.validateGroup(fixture),
      `group fixture #${i} diverged: ${JSON.stringify(fixture)}`,
    );
  });
});

// Feature 200 — console definitions.
const CONSOLE_FIXTURES = [
  { name: "shell", sshHost: "db.internal", credentialId: "cred-1" },
  {
    name: "shell",
    sshHost: "db.internal",
    sshPort: 2222,
    credentialId: "cred-1",
    jumpHostIds: ["j1"],
  },
  { name: "", sshHost: "db.internal", credentialId: "cred-1" },
  { name: "shell", sshHost: "", credentialId: "cred-1" },
  { name: "shell", sshHost: "db.internal", credentialId: "" },
  { name: "shell", sshHost: "db.internal", credentialId: "cred-1", sshPort: 0 },
  {
    name: "shell",
    sshHost: "db.internal",
    credentialId: "cred-1",
    sshPort: 70000,
  },
  {
    name: "shell",
    sshHost: "db.internal",
    credentialId: "cred-1",
    jumpHostIds: "nope",
  },
  {
    name: "shell",
    sshHost: "db.internal",
    credentialId: "cred-1",
    jumpHostIds: ["a", 5, ""],
  },
  {},
  null,
  [],
  "nope",
];

test("renderer and store validateConsole agree for every fixture", () => {
  CONSOLE_FIXTURES.forEach((fixture, i) => {
    assert.deepEqual(
      renderer.validateConsole(fixture),
      main.validateConsole(fixture),
      `console fixture #${i} diverged: ${JSON.stringify(fixture)}`,
    );
  });
});

test("the auth taxonomy matches", () => {
  assert.deepEqual(renderer.AUTH_TYPES, main.AUTH_TYPES);
  for (const type of [...renderer.AUTH_TYPES, "nope"]) {
    assert.equal(
      renderer.secretFieldForAuthType(type),
      main.secretFieldForAuthType(type),
      `secret field for "${type}" diverged`,
    );
  }
});

test("the group-colour palette matches", () => {
  assert.deepEqual(renderer.GROUP_COLORS, main.GROUP_COLORS);
  assert.equal(renderer.DEFAULT_GROUP_COLOR, main.DEFAULT_GROUP_COLOR);
});
