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
 * host-verifier.test.js — unit tests for SSH host-key verification, with a focus
 * on the security-critical HARD REJECT of a changed key (possible MITM), which
 * the integration suite never exercised. `makeHostVerifier` is pure given its
 * injected store / known_hosts file, so these drive it directly with crafted
 * wire-format key blobs (the verifier treats a key as an opaque buffer: it
 * fingerprints it and reads the leading algorithm name).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  makeHostVerifier,
  sha256Fingerprint,
  listOsKnownHosts,
  realHomeDir,
  defaultKnownHostsPath,
} = require("../host-verifier");

// A minimal SSH public-key wire blob: uint32be(algoLen) ++ algo ++ material.
function sshBlob(algo, material) {
  const algoBuf = Buffer.from(algo, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algoBuf.length, 0);
  return Buffer.concat([len, algoBuf, Buffer.from(material)]);
}

function knownHostsLine(host, keyType, blob, marker) {
  const entry = `${host} ${keyType} ${blob.toString("base64")}`;
  return marker ? `@${marker} ${entry}` : entry;
}

function tmpKnownHosts(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostverify-"));
  const file = path.join(dir, "known_hosts");
  fs.writeFileSync(file, content);
  return {
    file,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Resolve verify() synchronously-ish: the verifier calls it exactly once.
function runVerifier(verifier, key) {
  return new Promise((resolve) => verifier(key, resolve));
}

const HOST = "10.0.0.5";
const PORT = 2222;
const HOST_PORT = `${HOST}:${PORT}`;
// OpenSSH records a non-22 host under the bracketed `[host]:port` lookup name.
const LOOKUP = `[${HOST}]:${PORT}`;

function baseOpts(over = {}) {
  return {
    host: HOST,
    port: PORT,
    hopLabel: "sshServer",
    tunnelId: "t1",
    knownHostsStore: { get: () => null, trust: () => {} },
    knownHostsFile: "/nonexistent/known_hosts",
    requestTrust: async () => false,
    ...over,
  };
}

test("accepts a key whose fingerprint matches the TOFU store", async () => {
  const key = sshBlob("ssh-ed25519", "GOODKEY");
  const verifier = makeHostVerifier(
    baseOpts({
      knownHostsStore: {
        get: (hp) =>
          hp === HOST_PORT ? { fingerprint: sha256Fingerprint(key) } : null,
        trust: () => {},
      },
    }),
  );
  assert.equal(await runVerifier(verifier, key), true);
});

test("HARD REJECTS a changed key against the TOFU store (possible MITM)", async () => {
  const stored = sshBlob("ssh-ed25519", "ORIGINAL");
  const presented = sshBlob("ssh-ed25519", "IMPOSTER");
  const changed = [];
  const verifier = makeHostVerifier(
    baseOpts({
      knownHostsStore: {
        get: () => ({ fingerprint: sha256Fingerprint(stored) }),
        trust: () => assert.fail("must never persist a changed key"),
      },
      requestTrust: () =>
        assert.fail("must never prompt to trust a changed key"),
      reportChanged: (info) => changed.push(info),
    }),
  );
  assert.equal(await runVerifier(verifier, presented), false);
  assert.equal(changed.length, 1, "reports the changed key so the UI can warn");
  assert.equal(changed[0].fingerprint, sha256Fingerprint(presented));
});

test("accepts an exact match in ~/.ssh/known_hosts", async () => {
  const key = sshBlob("ssh-ed25519", "ONRECORD");
  const kh = tmpKnownHosts(knownHostsLine(LOOKUP, "ssh-ed25519", key));
  try {
    const verifier = makeHostVerifier(baseOpts({ knownHostsFile: kh.file }));
    assert.equal(await runVerifier(verifier, key), true);
  } finally {
    kh.cleanup();
  }
});

test("HARD REJECTS a same-type key that differs from known_hosts", async () => {
  const onRecord = sshBlob("ssh-ed25519", "ONRECORD");
  const presented = sshBlob("ssh-ed25519", "DIFFERENT");
  const kh = tmpKnownHosts(knownHostsLine(LOOKUP, "ssh-ed25519", onRecord));
  const changed = [];
  try {
    const verifier = makeHostVerifier(
      baseOpts({
        knownHostsFile: kh.file,
        requestTrust: () => assert.fail("a changed key must not prompt TOFU"),
        reportChanged: (info) => changed.push(info),
      }),
    );
    assert.equal(await runVerifier(verifier, presented), false);
    assert.equal(changed.length, 1);
  } finally {
    kh.cleanup();
  }
});

test("an unknown key holds pending, then trusts + persists on accept", async () => {
  const key = sshBlob("ssh-ed25519", "FRESH");
  const trusted = [];
  let prompted = null;
  const verifier = makeHostVerifier(
    baseOpts({
      knownHostsStore: {
        get: () => null,
        trust: (hp, fp) => trusted.push([hp, fp]),
      },
      requestTrust: async (info) => {
        prompted = info;
        return true;
      },
    }),
  );
  assert.equal(await runVerifier(verifier, key), true);
  assert.equal(prompted.hostPort, HOST_PORT);
  assert.deepEqual(trusted, [[HOST_PORT, sha256Fingerprint(key)]]);
});

test("an unknown key that the user declines is rejected and not persisted", async () => {
  const key = sshBlob("ssh-ed25519", "FRESH");
  const verifier = makeHostVerifier(
    baseOpts({
      knownHostsStore: {
        get: () => null,
        trust: () => assert.fail("a declined key must not be persisted"),
      },
      requestTrust: async () => false,
    }),
  );
  assert.equal(await runVerifier(verifier, key), false);
});

test("a @revoked known_hosts entry is never silently accepted", async () => {
  const key = sshBlob("ssh-ed25519", "REVOKED");
  const kh = tmpKnownHosts(
    knownHostsLine(LOOKUP, "ssh-ed25519", key, "revoked"),
  );
  let prompted = false;
  try {
    // The revoked entry is excluded from matches, so an exact-match key is NOT
    // auto-accepted — it falls through to a TOFU decision instead.
    const verifier = makeHostVerifier(
      baseOpts({
        knownHostsFile: kh.file,
        requestTrust: async () => {
          prompted = true;
          return false;
        },
      }),
    );
    assert.equal(await runVerifier(verifier, key), false);
    assert.ok(prompted, "a revoked key is not treated as an accepted match");
  } finally {
    kh.cleanup();
  }
});

test("a malformed key blob is rejected without throwing", async () => {
  // Too short to carry a uint32 length prefix → keyAlgorithm() throws internally.
  const verifier = makeHostVerifier(baseOpts());
  assert.equal(await runVerifier(verifier, Buffer.from([1, 2])), false);
});

// ── listOsKnownHosts (the read-only OS inventory for Settings → Host Keys) ─────

test("listOsKnownHosts reports host/fingerprint/keyType, hashes → null, skips @revoked", () => {
  const blobA = sshBlob("ssh-ed25519", "AAAA");
  const blobHashed = sshBlob("ssh-rsa", "BBBB");
  const blobRevoked = sshBlob("ssh-ed25519", "CCCC");
  const content = [
    knownHostsLine("github.com", "ssh-ed25519", blobA),
    // A hashed host (|1|salt|hash) — OpenSSH's default on some distros.
    knownHostsLine("|1|c2FsdA==|aGFzaA==", "ssh-rsa", blobHashed),
    // @revoked marks distrust, not a trusted key → excluded.
    knownHostsLine("evil.example.com", "ssh-ed25519", blobRevoked, "revoked"),
    "# a comment line is ignored",
    "",
  ].join("\n");
  const { file, cleanup } = tmpKnownHosts(content);
  try {
    const list = listOsKnownHosts(file);
    assert.equal(list.length, 2, "the @revoked line and comment are excluded");

    const named = list.find((e) => e.host === "github.com");
    assert.ok(named, "the plain host is listed by name");
    assert.equal(named.keyType, "ssh-ed25519");
    assert.equal(named.fingerprint, sha256Fingerprint(blobA));

    const hashed = list.find((e) => e.host === null);
    assert.ok(hashed, "a hashed host reports host:null (can't be reversed)");
    assert.equal(hashed.keyType, "ssh-rsa");
    assert.equal(hashed.fingerprint, sha256Fingerprint(blobHashed));
  } finally {
    cleanup();
  }
});

test("listOsKnownHosts tolerates an absent file", () => {
  assert.deepEqual(listOsKnownHosts("/no/such/dir/known_hosts"), []);
});

// In the MAS sandbox, $HOME (os.homedir()) is redirected to the app container, so
// the known_hosts path MUST derive from the real home (os.userInfo().homedir, via
// getpwuid) — otherwise it lands on a dead container path that never holds the
// user's file. Force the two apart and assert we follow userInfo, not homedir.
test("defaultKnownHostsPath resolves against the REAL home, not the redirected $HOME", () => {
  const realUserInfo = os.userInfo;
  const realHomedir = os.homedir;
  try {
    os.userInfo = () => ({ homedir: "/Users/real" });
    os.homedir = () => "/Users/real/Library/Containers/app/Data"; // sandbox $HOME
    assert.equal(realHomeDir(), "/Users/real");
    assert.equal(
      defaultKnownHostsPath(),
      path.join("/Users/real", ".ssh", "known_hosts"),
    );
  } finally {
    os.userInfo = realUserInfo;
    os.homedir = realHomedir;
  }
});

test("realHomeDir falls back to os.homedir() when getpwuid has no entry", () => {
  const realUserInfo = os.userInfo;
  const realHomedir = os.homedir;
  try {
    os.userInfo = () => {
      throw new Error("no passwd entry");
    };
    os.homedir = () => "/fallback/home";
    assert.equal(realHomeDir(), "/fallback/home");
  } finally {
    os.userInfo = realUserInfo;
    os.homedir = realHomedir;
  }
});
