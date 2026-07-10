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

const { buildReport, redact, summarizeTunnel } = require("../diagnostics");

test("the header carries generatedAt and every app field", () => {
  const report = buildReport({
    app: { version: "1.2.3", platform: "darwin", electron: "42.0.0" },
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
  assert.ok(report.startsWith("Port Hippo diagnostics report"));
  assert.ok(report.includes("generated: 2026-07-08T00:00:00.000Z"));
  assert.ok(report.includes("version: 1.2.3"));
  assert.ok(report.includes("platform: darwin"));
  assert.ok(report.includes("electron: 42.0.0"));
  assert.ok(report.endsWith("\n"));
});

test("tunnels are summarized without any secret material", () => {
  const report = buildReport({
    tunnels: [
      {
        name: "Prod DB",
        localPort: 5432,
        destination: { host: "db.internal", port: 5432 },
        sshHost: "bastion",
        sshPort: 22,
        credentialId: "cred-1",
        jumpHostIds: ["jump-1"],
        enabled: true,
      },
    ],
  });
  assert.ok(report.includes("--- tunnels (1) ---"));
  assert.ok(report.includes("Prod DB"));
  assert.ok(report.includes("local :5432 → db.internal:5432 via bastion:22"));
  assert.ok(report.includes("jumps: 1"));
  assert.ok(report.includes("credential: set"));
});

test("credentials are summarized by label + type, never their secret", () => {
  const report = buildReport({
    credentials: [
      {
        id: "c1",
        label: "Prod key",
        user: "jason",
        authType: "key",
        hasSecret: true,
      },
      {
        id: "c2",
        label: "Agent",
        user: "jason",
        authType: "agent",
        hasSecret: false,
      },
    ],
  });
  assert.ok(report.includes("--- credentials (2) ---"));
  assert.ok(report.includes("Prod key: key (secret set)"));
  assert.ok(report.includes("Agent: agent"));
});

test("no logs and empty logs render their placeholders", () => {
  assert.ok(buildReport({}).includes("(no log files found)"));
  assert.ok(buildReport({ tunnels: [] }).includes("(none defined)"));

  const withEmpty = buildReport({ logs: [{ name: "main.log", content: "" }] });
  assert.ok(withEmpty.includes("----- main.log -----"));
  assert.ok(withEmpty.includes("(empty)"));
});

test("logs render oldest-first under per-file headers", () => {
  const report = buildReport({
    logs: [
      { name: "main.1.log", content: "older\n" },
      { name: "main.log", content: "newer\n" },
    ],
  });
  assert.ok(report.indexOf("main.1.log") < report.indexOf("main.log"));
  assert.ok(report.indexOf("older") < report.indexOf("newer"));
});

test("redact scrubs PEM keys, secret key/values and URL credentials", () => {
  const secretLaden = [
    "connecting to ssh://alice:sup3rSecret@bastion:22",
    'auth password="hunter2primary"',
    "passphrase: my-key-passphrase",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAA_TOP_SECRET_KEY_MATERIAL",
    "-----END OPENSSH PRIVATE KEY-----",
  ].join("\n");

  const cleaned = redact(secretLaden);
  assert.ok(!cleaned.includes("sup3rSecret"));
  assert.ok(!cleaned.includes("hunter2primary"));
  assert.ok(!cleaned.includes("my-key-passphrase"));
  assert.ok(!cleaned.includes("TOP_SECRET_KEY_MATERIAL"));
  assert.ok(cleaned.includes("[redacted]"));
  assert.ok(cleaned.includes("[redacted private key]"));
});

test("a report never leaks a secret that slipped into a log line", () => {
  const report = buildReport({
    app: { version: "9.9.9" },
    logs: [
      {
        name: "main.log",
        content: 'error connecting password="leaked-secret-value"\n',
      },
    ],
  });
  assert.ok(!report.includes("leaked-secret-value"));
  assert.ok(report.includes("[redacted]"));
});

test("summarizeTunnel marks a tunnel with no bastion as direct", () => {
  const line = summarizeTunnel({
    name: "x",
    localPort: 1,
    destination: { host: "h", port: 2 },
  });
  assert.ok(line.includes("(direct)"));
  assert.ok(line.includes("credential: none"));
});
