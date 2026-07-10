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
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const io = require("../io");
const crypto = require("../crypto");
const { Paths } = require("../paths");
const { SecretStorage } = require("../secret-storage");

// A fresh temp profile + store per test. crypto is a process-wide singleton, so
// each test also resets it (node --test isolates by FILE, not by test).
function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "porthippo-secret-"));
  const paths = new Paths(dir);
  return { dir, paths, sec: new SecretStorage(paths) };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// A minimal, functional safeStorage stand-in so os-keychain seal/open works in a
// plain Node process (the real one only exists inside Electron).
function keychainMock() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`KS:${s}`, "utf8"),
    decryptString: (buf) => buf.toString("utf8").slice(3),
  };
}

// A tunnels.json document carrying two sealed secrets on credential records: a
// password credential and a key-passphrase credential (the two secret-bearing
// shapes Port Hippo stores since Feature 45). A tunnel + jump host reference them
// but hold no secret themselves.
function tunnelsDoc(passwordEnc, passphraseEnc) {
  return {
    credentials: [
      {
        id: "c1",
        label: "db",
        user: "u",
        authType: "password",
        password: { enc: passwordEnc },
      },
      {
        id: "c2",
        label: "key",
        user: "u",
        authType: "key",
        keyPath: "/k",
        passphrase: { enc: passphraseEnc },
      },
    ],
    jumpHosts: [
      {
        id: "j1",
        label: "bastion",
        host: "bastion",
        port: 22,
        credentialId: "c2",
      },
    ],
    tunnels: [
      {
        id: "t1",
        name: "one",
        localPort: 5432,
        destination: { host: "db", port: 5432 },
        credentialId: "c1",
        jumpHostIds: ["j1"],
      },
    ],
  };
}

// Every sealed ciphertext string in a tunnels.json document (test-local walker).
function sealedValues(doc) {
  const out = [];
  for (const cred of doc.credentials || []) {
    for (const field of ["password", "passphrase"]) {
      if (cred[field] && typeof cred[field].enc === "string") {
        out.push(cred[field].enc);
      }
    }
  }
  return out;
}

const PREFIX_OF = {
  "app-key": "enck:v1:",
  "os-keychain": "enc:v1:",
  "master-password": "encm:v1:",
};

test.beforeEach(() => {
  crypto._setSafeStorage(null);
  crypto.configure({ mode: "app-key", appKey: null, masterKey: null });
});

// ── reencryptAll: convert every secret across all three directions ─────────────

test("reencryptAll converts every stored secret across all three backends", () => {
  const { dir, paths, sec } = fresh();
  try {
    // Seal two secrets under the app key (the real 0600 file), then load every
    // key so decrypt-by-prefix works whatever the current family is.
    const appKey = sec.ensureAppKey();
    const masterKey = randomBytes(32);
    crypto._setSafeStorage(keychainMock());
    crypto.configure({ mode: "app-key", appKey, masterKey });

    const pw = crypto.encryptString("db-pass");
    const pass = crypto.encryptString("key-phrase");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pass));

    for (const target of ["master-password", "os-keychain", "app-key"]) {
      const res = sec.reencryptAll(target);
      assert.deepEqual(res, { ok: true, failures: [] }, `→ ${target}`);

      const values = sealedValues(io.readJSON(paths.tunnelsPath()));
      assert.equal(values.length, 2, "both secrets survive");
      for (const v of values) {
        assert.ok(v.startsWith(PREFIX_OF[target]), `${target}: ${v}`);
      }
      // The plaintext is unchanged after the round-trip.
      assert.deepEqual(values.map((v) => crypto.decryptString(v)).sort(), [
        "db-pass",
        "key-phrase",
      ]);
    }
  } finally {
    crypto._setSafeStorage(null);
    cleanup(dir);
  }
});

test("reencryptAll aborts with nothing written when a secret can't be decrypted", () => {
  const { dir, paths, sec } = fresh();
  try {
    // A secret sealed under the keystore...
    crypto._setSafeStorage(keychainMock());
    crypto.configure({ mode: "os-keychain", appKey: null, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    const before = tunnelsDoc(pw, pw);
    io.writeJSON(paths.tunnelsPath(), before);

    // ...then the keystore vanishes → the validate pass fails.
    crypto._setSafeStorage(null);
    const res = sec.reencryptAll("app-key");
    assert.equal(res.ok, false);
    assert.ok(res.failures.length >= 1);
    assert.equal(res.failures[0].file, "tunnels");

    // Nothing was rewritten — the file still holds the original ciphertext.
    assert.deepEqual(sealedValues(io.readJSON(paths.tunnelsPath())), [pw, pw]);
  } finally {
    cleanup(dir);
  }
});

// ── verifyMasterPassword ───────────────────────────────────────────────────────

test("verifyMasterPassword returns the key for the right password, null otherwise", () => {
  const { dir, sec } = fresh();
  try {
    const prep = sec.prepareMasterPassword("correct horse battery staple");
    const config = {
      mode: "master-password",
      kdf: prep.kdf,
      verifier: prep.verifier,
    };

    const key = sec.verifyMasterPassword(
      "correct horse battery staple",
      config,
    );
    assert.ok(Buffer.isBuffer(key));
    assert.deepEqual(key, prep.key, "re-derives the same key");

    assert.equal(sec.verifyMasterPassword("wrong", config), null);
    // A config missing the kdf/verifier can't be verified.
    assert.equal(
      sec.verifyMasterPassword("x", { mode: "master-password" }),
      null,
    );
  } finally {
    cleanup(dir);
  }
});

// ── resumeMigration: crash recovery ────────────────────────────────────────────

test("bootstrap auto-finishes a crash-interrupted no-password migration", () => {
  const { dir, paths, sec } = fresh();
  try {
    const appKey = sec.ensureAppKey();
    crypto._setSafeStorage(keychainMock());
    crypto.configure({ mode: "app-key", appKey, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pw));

    // Simulate a crash mid-switch app-key → os-keychain: marker written, mode
    // still `from`, secrets still enck:.
    sec.markMigration("app-key", "os-keychain");

    // Next launch: a fresh store bootstraps and finishes the switch.
    const boot = new SecretStorage(paths).bootstrap();
    assert.equal(boot.mode, "os-keychain");
    assert.equal(boot.locked, false);
    assert.equal(sec.pendingMigration(), null, "marker cleared");
    assert.equal(
      sec.readAppKey(),
      null,
      "app key deleted after leaving app-key",
    );

    const values = sealedValues(io.readJSON(paths.tunnelsPath()));
    for (const v of values) assert.ok(v.startsWith("enc:v1:"));
    assert.equal(crypto.decryptString(values[0]), "db-pass");
  } finally {
    crypto._setSafeStorage(null);
    cleanup(dir);
  }
});

test("resumeMigration defers a master-password switch until unlocked, then finishes it", () => {
  const { dir, paths, sec } = fresh();
  try {
    const appKey = sec.ensureAppKey();
    crypto.configure({ mode: "app-key", appKey, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pw));

    const prep = sec.prepareMasterPassword("open sesame");
    sec.markMigration("app-key", "master-password", {
      kdf: prep.kdf,
      verifier: prep.verifier,
    });

    // No key yet → deferred, marker left intact.
    const deferred = sec.resumeMigration({});
    assert.equal(deferred.status, "needs-unlock");
    assert.ok(sec.pendingMigration(), "marker survives a deferral");

    // With the derived key → finishes; secrets become encm: and the mode flips.
    const done = sec.resumeMigration({ masterKey: prep.key });
    assert.equal(done.status, "resumed");
    assert.equal(sec.pendingMigration(), null);
    assert.equal(sec.readConfig().mode, "master-password");
    assert.equal(
      sec.readAppKey(),
      null,
      "app key deleted after leaving app-key",
    );

    const values = sealedValues(io.readJSON(paths.tunnelsPath()));
    for (const v of values) assert.ok(v.startsWith("encm:v1:"));
    assert.equal(crypto.decryptString(values[0]), "db-pass"); // key now loaded
  } finally {
    cleanup(dir);
  }
});

test("resumeMigration leaves the marker in place when re-encryption fails", () => {
  const { dir, paths, sec } = fresh();
  try {
    // Secret sealed under the keystore, marker os-keychain → app-key...
    crypto._setSafeStorage(keychainMock());
    crypto.configure({ mode: "os-keychain", appKey: null, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pw));
    sec.markMigration("os-keychain", "app-key");

    // ...but the keystore is now unavailable → the source can't be read.
    crypto._setSafeStorage(null);
    const res = sec.resumeMigration({});
    assert.equal(res.status, "failed");
    assert.ok(res.failures.length >= 1);

    // Marker intact, mode NOT flipped, file untouched.
    assert.ok(sec.pendingMigration());
    assert.equal(sec.readConfig().mode, "os-keychain");
    assert.deepEqual(sealedValues(io.readJSON(paths.tunnelsPath())), [pw, pw]);
  } finally {
    cleanup(dir);
  }
});

// ── setMode / unlock (the IPC-facing operations) ───────────────────────────────

test("setMode re-encrypts to master-password, boots locked next launch, unlock reads again", () => {
  const { dir, paths, sec } = fresh();
  try {
    const appKey = sec.ensureAppKey();
    crypto.configure({ mode: "app-key", appKey, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pw));
    sec.writeConfig({ mode: "app-key" });

    // Switch to master-password.
    const res = sec.setMode("master-password", "open sesame");
    assert.deepEqual(res, { ok: true });
    assert.equal(crypto.getMode(), "master-password");
    assert.equal(crypto.isLocked(), false, "unlocked right after setting it");
    for (const v of sealedValues(io.readJSON(paths.tunnelsPath()))) {
      assert.ok(v.startsWith("encm:v1:"));
    }

    // Next launch boots LOCKED (the key isn't persisted).
    const boot = new SecretStorage(paths).bootstrap();
    assert.equal(boot.mode, "master-password");
    assert.equal(boot.locked, true);
    assert.equal(crypto.isLocked(), true);

    // Wrong password is rejected; the right one unlocks for the session.
    const sec2 = new SecretStorage(paths);
    assert.deepEqual(sec2.unlock("nope"), {
      ok: false,
      reason: "bad-password",
    });
    assert.deepEqual(sec2.unlock("open sesame"), { ok: true });
    assert.equal(crypto.isLocked(), false);
    const values = sealedValues(io.readJSON(paths.tunnelsPath()));
    assert.equal(crypto.decryptString(values[0]), "db-pass");
  } finally {
    cleanup(dir);
  }
});

test("setMode refuses OS keychain when safeStorage is unavailable (no plaintext downgrade)", () => {
  const { dir, paths, sec } = fresh();
  try {
    const appKey = sec.ensureAppKey();
    crypto._setSafeStorage(null); // keychain unavailable
    crypto.configure({ mode: "app-key", appKey, masterKey: null });
    const pw = crypto.encryptString("db-pass");
    io.writeJSON(paths.tunnelsPath(), tunnelsDoc(pw, pw));
    sec.writeConfig({ mode: "app-key" });

    const res = sec.setMode("os-keychain");
    assert.deepEqual(res, { ok: false, reason: "keychain-unavailable" });
    // Nothing changed: still app-key, still enck:, no migration marker left.
    assert.equal(crypto.getMode(), "app-key");
    assert.equal(sec.pendingMigration(), null);
    for (const v of sealedValues(io.readJSON(paths.tunnelsPath()))) {
      assert.ok(v.startsWith("enck:v1:"));
    }
  } finally {
    cleanup(dir);
  }
});

test("setMode is a no-op when the target equals the current mode", () => {
  const { dir, paths, sec } = fresh();
  try {
    crypto.configure({ mode: "app-key", appKey: sec.ensureAppKey() });
    sec.writeConfig({ mode: "app-key" });
    assert.deepEqual(sec.setMode("app-key"), { ok: true, unchanged: true });
  } finally {
    cleanup(dir);
  }
});
