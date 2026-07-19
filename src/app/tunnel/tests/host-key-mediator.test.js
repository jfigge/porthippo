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
 * host-key-mediator.test.js — the shared TOFU prompt mediator (Feature 200). An
 * unknown key holds the handshake pending, broadcasts jumphippo:hostkey-unknown,
 * and resolves once trust()/reject() answers; a trusted key is persisted. This is
 * the one place the tunnel engine + console manager share, so their TOFU can't drift.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { HostKeyMediator } = require("../host-key-mediator");

const tick = () => new Promise((r) => setTimeout(r, 10));

// A minimal well-formed SSH key blob: <uint32 len><algo><padding>, enough for the
// verifier's fingerprint + algorithm parsing.
function keyBlob(algo = "ssh-ed25519") {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algo.length, 0);
  return Buffer.concat([
    len,
    Buffer.from(algo),
    Buffer.from([0, 0, 0, 4, 9, 9]),
  ]);
}

function makeMediator({ knownHostsStore, broadcasts }) {
  return new HostKeyMediator({
    getStores: () => ({ knownHostsStore: () => knownHostsStore }),
    knownHostsFile: "/nonexistent/jumphippo-test/known_hosts",
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
  });
}

test("an unknown key prompts, and trust() accepts + persists it", async () => {
  const trusted = [];
  const knownHostsStore = {
    get: () => null,
    trust: (hostPort, fp) => trusted.push({ hostPort, fp }),
  };
  const broadcasts = [];
  const mediator = makeMediator({ knownHostsStore, broadcasts });

  const verify = mediator.buildVerifier({
    host: "h",
    port: 22,
    hopLabel: "sshServer",
    tunnelId: "c1",
  });

  let verified = null;
  verify(keyBlob(), (ok) => (verified = ok));
  await tick();

  const prompt = broadcasts.find(
    (b) => b.channel === "jumphippo:hostkey-unknown",
  );
  assert.ok(prompt, "an unknown-key prompt was broadcast");
  assert.ok(prompt.payload.promptId, "the prompt carries an id");
  assert.equal(verified, null, "still pending before the user answers");

  const res = mediator.trust(prompt.payload.promptId);
  assert.deepEqual(res, {
    ok: true,
    promptId: prompt.payload.promptId,
    accepted: true,
  });
  await tick();
  assert.equal(verified, true, "the handshake is accepted");
  assert.equal(trusted.length, 1, "the accepted key is persisted");
});

test("reject() refuses the handshake", async () => {
  const broadcasts = [];
  const mediator = makeMediator({
    knownHostsStore: { get: () => null, trust: () => {} },
    broadcasts,
  });
  const verify = mediator.buildVerifier({
    host: "h",
    port: 22,
    hopLabel: "sshServer",
    tunnelId: "c1",
  });
  let verified = null;
  verify(keyBlob(), (ok) => (verified = ok));
  await tick();
  const prompt = broadcasts.find(
    (b) => b.channel === "jumphippo:hostkey-unknown",
  );
  mediator.reject(prompt.payload.promptId);
  await tick();
  assert.equal(verified, false);
});

test("trust()/reject() of an unknown promptId is a no-op result", () => {
  const mediator = makeMediator({
    knownHostsStore: { get: () => null, trust: () => {} },
    broadcasts: [],
  });
  assert.deepEqual(mediator.trust("nope"), { ok: false, promptId: "nope" });
  assert.deepEqual(mediator.reject("nope"), { ok: false, promptId: "nope" });
});

test("rejectAll() refuses every pending prompt", async () => {
  const broadcasts = [];
  const mediator = makeMediator({
    knownHostsStore: { get: () => null, trust: () => {} },
    broadcasts,
  });
  const verify = mediator.buildVerifier({
    host: "h",
    port: 22,
    hopLabel: "sshServer",
    tunnelId: "c1",
  });
  let verified = null;
  verify(keyBlob(), (ok) => (verified = ok));
  await tick();
  mediator.rejectAll();
  await tick();
  assert.equal(verified, false);
});
