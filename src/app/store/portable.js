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
 * portable.js — the `.jumphippo` backup/restore bundle (Feature 120).
 *
 * A bundle is a versioned, self-describing document — never the raw tunnels.json:
 *
 *   { format: "jumphippo-bundle", version: 1, exportedAt,
 *     secrets: "stripped" | "encp:v1",
 *     contents: { tunnels[], credentials[], jumpHosts[], settings? } }
 *
 * The tunnels / credentials / jump hosts are the reference-shape records the store
 * holds (referential integrity by id is preserved) — but the at-rest sealed secret
 * is NEVER copied verbatim: a device-key / OS-keychain blob only decrypts on the
 * machine that wrote it. Instead export UNSEALS each secret in main and either
 *   - drops it        (`secrets: "stripped"`, the default), or
 *   - re-seals it     under a portable passphrase envelope (`encp:v1:`), which is
 *                     independent of the at-rest backend and gated behind an
 *                     explicit passphrase.
 * A plaintext secret is never written to disk.
 *
 * Import re-seals every restored secret under the LOCAL machine's active backend
 * (via credential-secrets.sealCredential), so an imported store matches every
 * other secret on that machine. Import is a reviewed MERGE (add new, reuse
 * label-collisions, rename tunnel-name collisions, never clobber an existing
 * secret with a stripped one) or an explicitly-confirmed REPLACE (wipe + load).
 * A bundle with a dangling reference is rejected whole (never a half-applied store).
 *
 * The `encp:v1:` envelope shares the PBKDF2 KDF with the master-password backend
 * (crypto.deriveKey / crypto.PBKDF2_ITERATIONS); its salt + iterations ride inside
 * the self-describing blob so a bundle carries everything needed to open it given
 * the passphrase. `encp:` is NEVER accepted as an at-rest backend — it exists only
 * inside a bundle.
 *
 * All crypto + I/O run in main. This module also owns the commit of an SSH-config
 * import proposal (applySshProposal) — the same "reseal + id-remap + one atomic
 * write" machinery the bundle merge uses (ssh-config.js stays a pure parser).
 */
"use strict";

const nodeCrypto = require("crypto");
const io = require("./io");
const { readDoc, writeDoc } = require("./definitions-doc");
const {
  SECRET_FIELDS,
  sealCredential,
  decryptCredential,
} = require("./credential-secrets");
const { secretFieldForAuthType } = require("./validate");
const {
  deriveKey,
  PBKDF2_ITERATIONS,
  _aesGcmEncrypt,
  _aesGcmDecrypt,
} = require("./crypto");

const FORMAT = "jumphippo-bundle";
const VERSION = 1;

// Portable-secret ciphertext family. A DISTINCT prefix from the at-rest families
// (enc:/enck:/encm:) — it lives only inside a bundle and is never a store backend.
const PORTABLE_PREFIX = "encp:v1:";
const PORTABLE_SALT_LEN = 16;

// The secret-free settings subset a bundle may carry (opt-in). Device-specific
// settings (window bounds, tray hint, launch-at-login, start-minimized) are
// deliberately excluded so a restore never drags one machine's chrome onto another.
const PORTABLE_SETTINGS_KEYS = [
  "theme",
  "language",
  "fontSize",
  "fontFamily",
  "defaultLingerMs",
  "defaultBindHost",
  "defaultKeepAlive",
  "viewMode",
  "monitorFilter",
  "armOnLaunch",
  "confirmOnQuit",
];

// The reference-tunnel fields a bundle carries. `order`/`routeSummary` are DERIVED
// (never stored), so they are dropped on export.
const TUNNEL_FIELDS = [
  "id",
  "name",
  "type",
  "enabled",
  "keepAlive",
  "autoReconnect",
  "lingerMs",
  "bindHost",
  "localPort",
  "sshHost",
  "sshPort",
  "credentialId",
  "jumpHostIds",
  "destination",
  "remoteBind",
  "entryAddress",
  "exitAddress",
];

/** A tagged error the IPC layer surfaces as a discriminable `{ __hippoError }`. */
function bundleError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

// ── Portable-passphrase envelope (encp:v1:) ─────────────────────────────────────

/** True when `v` is an `encp:v1:` portable-secret ciphertext string. */
function isPortableSecret(v) {
  return typeof v === "string" && v.startsWith(PORTABLE_PREFIX);
}

/**
 * Seal a plaintext secret under a passphrase: PBKDF2(salt) → AES-256-GCM. The
 * salt + iteration count ride inside the blob (salt|iters|iv|tag|ct) so the bundle
 * is self-describing. Empty input returns "" — nothing to seal.
 * @param {string} plain
 * @param {string} passphrase
 * @returns {string} `encp:v1:<base64>`
 */
function sealPassphrase(plain, passphrase) {
  if (!plain) return "";
  const salt = nodeCrypto.randomBytes(PORTABLE_SALT_LEN);
  const iterations = PBKDF2_ITERATIONS;
  const key = deriveKey(passphrase, salt, iterations);
  const iters = Buffer.alloc(4);
  iters.writeUInt32BE(iterations);
  const body = _aesGcmEncrypt(plain, key); // iv|tag|ct
  return (
    PORTABLE_PREFIX + Buffer.concat([salt, iters, body]).toString("base64")
  );
}

/**
 * Open an `encp:v1:` blob with a passphrase. Throws on a wrong passphrase (the GCM
 * tag mismatch) or a malformed blob — the caller turns that into BAD_PASSPHRASE.
 * @param {string} value
 * @param {string} passphrase
 * @returns {string} plaintext
 */
function openPassphrase(value, passphrase) {
  const raw = Buffer.from(value.slice(PORTABLE_PREFIX.length), "base64");
  if (raw.length < PORTABLE_SALT_LEN + 4 + 28) throw new Error("malformed");
  const salt = raw.subarray(0, PORTABLE_SALT_LEN);
  const iterations = raw.readUInt32BE(PORTABLE_SALT_LEN);
  const body = raw.subarray(PORTABLE_SALT_LEN + 4);
  const key = deriveKey(passphrase, salt, iterations);
  return _aesGcmDecrypt(body, key);
}

// ── Export ──────────────────────────────────────────────────────────────────────

/**
 * Build a `.jumphippo` bundle from the live store.
 *
 * @param {import('./stores').Stores} stores
 * @param {object} opts
 * @param {boolean} [opts.includeSettings]  carry the secret-free settings subset
 * @param {"stripped"|"encp"} [opts.secretMode]  strip secrets (default) or seal
 *        them under `passphrase`
 * @param {string} [opts.passphrase]  required when secretMode === "encp"
 * @returns {object} the bundle document
 */
function buildBundle(stores, { includeSettings, secretMode, passphrase } = {}) {
  const seal = secretMode === "encp";
  if (seal && (typeof passphrase !== "string" || passphrase.length === 0)) {
    throw bundleError("PASSPHRASE_REQUIRED", "a passphrase is required");
  }

  const tunnels = stores
    .tunnelStore()
    .list()
    .map((t) => pickTunnel(t));

  const credentials = stores
    .credentialStore()
    .listDecrypted()
    .map((cred) => exportCredential(cred, seal, passphrase));

  const jumpHosts = stores
    .jumpHostStore()
    .list()
    .map((j) => ({
      id: j.id,
      label: j.label,
      host: j.host,
      port: j.port,
      credentialId: j.credentialId,
    }));

  const contents = { tunnels, credentials, jumpHosts };
  if (includeSettings) {
    contents.settings = pickSettings(stores.settingsStore().get());
  }

  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    secrets: seal ? "encp:v1" : "stripped",
    contents,
  };
}

/** The reference-tunnel subset a bundle carries (no derived/order fields). */
function pickTunnel(t) {
  const out = {};
  for (const f of TUNNEL_FIELDS) if (t[f] !== undefined) out[f] = t[f];
  return out;
}

/** Whitelist a settings object down to the portable, secret-free subset. */
function pickSettings(settings) {
  const out = {};
  for (const k of PORTABLE_SETTINGS_KEYS) {
    if (settings[k] !== undefined) out[k] = settings[k];
  }
  return out;
}

/**
 * Map a DECRYPTED credential to its bundle form. The secret is dropped (stripped)
 * or re-sealed under the portable passphrase; a secret we couldn't decrypt on this
 * machine (decryptError — e.g. a locked master key) is treated as stripped.
 */
function exportCredential(cred, seal, passphrase) {
  const out = { id: cred.id, label: cred.label, user: cred.user };
  if (cred.authType) out.authType = cred.authType;
  if (cred.authType === "key" && cred.keyPath) out.keyPath = cred.keyPath;

  const field = secretFieldForAuthType(cred.authType);
  if (seal && field && !cred.decryptError) {
    const plain = cred[field];
    if (typeof plain === "string" && plain.length > 0) {
      out[field] = sealPassphrase(plain, passphrase);
    }
  }
  return out;
}

// ── Validation ──────────────────────────────────────────────────────────────────

/**
 * Structurally validate a bundle and its internal referential integrity. Throws a
 * tagged error (INVALID_BUNDLE / DANGLING_REF) so nothing is written on a bad one.
 * Returns the normalised `{ tunnels, credentials, jumpHosts, settings }`.
 */
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw bundleError("INVALID_BUNDLE", "not a Jump Hippo bundle");
  }
  if (bundle.format !== FORMAT) {
    throw bundleError("INVALID_BUNDLE", "not a Jump Hippo bundle");
  }
  if (bundle.version !== VERSION) {
    throw bundleError("INVALID_BUNDLE", `unsupported bundle version`);
  }
  if (bundle.secrets !== "stripped" && bundle.secrets !== "encp:v1") {
    throw bundleError("INVALID_BUNDLE", "unknown secret mode");
  }
  const c = bundle.contents;
  if (!c || typeof c !== "object") {
    throw bundleError("INVALID_BUNDLE", "bundle has no contents");
  }
  const tunnels = Array.isArray(c.tunnels) ? c.tunnels : [];
  const credentials = Array.isArray(c.credentials) ? c.credentials : [];
  const jumpHosts = Array.isArray(c.jumpHosts) ? c.jumpHosts : [];

  const credIds = new Set(credentials.map((x) => x && x.id));
  const jumpIds = new Set(jumpHosts.map((x) => x && x.id));

  for (const j of jumpHosts) {
    if (!j || !credIds.has(j.credentialId)) {
      throw bundleError(
        "DANGLING_REF",
        `jump host references a missing credential`,
      );
    }
  }
  for (const t of tunnels) {
    if (!t || !credIds.has(t.credentialId)) {
      throw bundleError(
        "DANGLING_REF",
        `tunnel references a missing credential`,
      );
    }
    const ids = Array.isArray(t.jumpHostIds) ? t.jumpHostIds : [];
    for (const id of ids) {
      if (!jumpIds.has(id)) {
        throw bundleError(
          "DANGLING_REF",
          `tunnel references a missing jump host`,
        );
      }
    }
  }

  const settings =
    c.settings && typeof c.settings === "object" ? c.settings : null;
  return { tunnels, credentials, jumpHosts, settings };
}

/**
 * Classify each bundle record against the current store for the import preview,
 * WITHOUT writing anything. A bad/dangling bundle is reported as `{ ok:false }`.
 *
 * @param {object} bundle
 * @param {{tunnels:object[], credentials:object[], jumpHosts:object[]}} current
 * @returns {object} the preview result
 */
function previewBundle(bundle, current) {
  let parts;
  try {
    parts = validateBundle(bundle);
  } catch (err) {
    return { ok: false, error: err.code || "INVALID_BUNDLE" };
  }

  const byId = (arr) => new Set(arr.map((x) => x && x.id));
  const labels = (arr, key) => new Set(arr.map((x) => x && x[key]));
  const curCredIds = byId(current.credentials);
  const curCredLabels = labels(current.credentials, "label");
  const curJumpIds = byId(current.jumpHosts);
  const curJumpLabels = labels(current.jumpHosts, "label");
  const curTunIds = byId(current.tunnels);
  const curTunNames = labels(current.tunnels, "name");

  const classify = (rec, idSet, labelSet, key) => {
    if (idSet.has(rec.id)) return "update";
    if (labelSet.has(rec[key])) return "conflict";
    return "add";
  };

  const credRecords = parts.credentials.map((c) => ({
    label: c.label,
    status: classify(c, curCredIds, curCredLabels, "label"),
  }));
  const jumpRecords = parts.jumpHosts.map((j) => ({
    label: j.label,
    status: classify(j, curJumpIds, curJumpLabels, "label"),
  }));
  const tunnelRecords = parts.tunnels.map((t) => ({
    label: t.name,
    status: classify(t, curTunIds, curTunNames, "name"),
  }));

  const tally = (recs) => {
    const out = { add: 0, update: 0, conflict: 0 };
    for (const r of recs) out[r.status] += 1;
    return out;
  };

  return {
    ok: true,
    secrets: bundle.secrets,
    needsPassphrase: bundle.secrets === "encp:v1",
    exportedAt: bundle.exportedAt,
    hasSettings: Boolean(parts.settings),
    records: {
      credentials: credRecords,
      jumpHosts: jumpRecords,
      tunnels: tunnelRecords,
    },
    counts: {
      credentials: tally(credRecords),
      jumpHosts: tally(jumpRecords),
      tunnels: tally(tunnelRecords),
    },
  };
}

// ── Import ──────────────────────────────────────────────────────────────────────

/**
 * Apply a bundle to the store. Validates first (throws on invalid/dangling so
 * nothing is written), decrypts every `encp:` secret up front (a wrong passphrase
 * throws BAD_PASSPHRASE before any write), re-seals under the local backend, merges
 * (or replaces), and writes the whole document in ONE atomic pass.
 *
 * @param {import('./stores').Stores} stores
 * @param {object} bundle
 * @param {object} opts
 * @param {"merge"|"replace"} [opts.mode]  default "merge"
 * @param {string} [opts.passphrase]  required for an `encp:` bundle
 * @returns {{ok:true, counts:object}}
 */
function applyBundle(stores, bundle, { mode = "merge", passphrase } = {}) {
  const parts = validateBundle(bundle); // throws on invalid/dangling

  // Pre-pass: decrypt every portable secret so a wrong passphrase aborts with
  // nothing written (mirrors the store's all-or-nothing re-encryption).
  const plainById = new Map();
  if (bundle.secrets === "encp:v1") {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      throw bundleError("PASSPHRASE_REQUIRED", "a passphrase is required");
    }
    for (const c of parts.credentials) {
      const field = secretFieldForAuthType(c.authType);
      const val = field ? c[field] : undefined;
      if (isPortableSecret(val)) {
        try {
          plainById.set(c.id, openPassphrase(val, passphrase));
        } catch {
          throw bundleError("BAD_PASSPHRASE", "incorrect passphrase");
        }
      }
    }
  }

  const paths = stores.paths();
  const current = readDoc(paths);

  const next =
    mode === "replace"
      ? replaceDoc(parts, plainById)
      : mergeDoc(parts, plainById, current);

  // The bundle only carries tunnels / credentials / jump hosts, so preserve the
  // document's other slices (groups — Feature 140; consoles — Feature 200) across
  // an import rather than letting writeDoc default the absent keys to []. Spreading
  // `current` first keeps those untouched; `next` overrides the imported slices.
  writeDoc(paths, { ...current, ...next });

  if (parts.settings) {
    try {
      stores.settingsStore().set(pickSettings(parts.settings));
    } catch (err) {
      console.warn(`[portable] settings import skipped: ${err && err.message}`);
    }
  }

  return { ok: true, counts: next.__counts };
}

/** Seal an imported credential under the LOCAL backend (plaintext → {enc}). */
function sealImportedCredential(bundleCred, plain, existing) {
  const incoming = {
    label: bundleCred.label,
    user: bundleCred.user,
    authType: bundleCred.authType,
  };
  if (bundleCred.authType === "key" && bundleCred.keyPath) {
    incoming.keyPath = bundleCred.keyPath;
  }
  const field = secretFieldForAuthType(bundleCred.authType);
  if (field) {
    if (typeof plain === "string" && plain.length > 0) {
      incoming[field] = plain; // fresh plaintext → sealed under the local backend
    } else if (existing) {
      incoming.hasSecret = true; // keep the existing sealed secret (never clobbered)
    }
  }
  return sealCredential(incoming, existing);
}

/** The reference-tunnel record for the store (remapped refs, no derived fields). */
function importTunnel(bundleTun, credRemap, jumpRemap, id, name) {
  const out = pickTunnel(bundleTun);
  out.id = id;
  out.name = name;
  out.credentialId = credRemap.get(bundleTun.credentialId) ?? out.credentialId;
  const ids = Array.isArray(bundleTun.jumpHostIds) ? bundleTun.jumpHostIds : [];
  out.jumpHostIds = ids.map((jid) => jumpRemap.get(jid) ?? jid);
  return out;
}

/** REPLACE: wipe and load the bundle verbatim (ids kept), re-sealing secrets. */
function replaceDoc(parts, plainById) {
  const credRemap = new Map();
  const jumpRemap = new Map();

  const credentials = parts.credentials.map((c) => {
    credRemap.set(c.id, c.id);
    const sealed = sealImportedCredential(c, plainById.get(c.id), undefined);
    sealed.id = c.id;
    return sealed;
  });
  const jumpHosts = parts.jumpHosts.map((j) => {
    jumpRemap.set(j.id, j.id);
    return {
      id: j.id,
      label: j.label,
      host: j.host,
      port: j.port,
      credentialId: credRemap.get(j.credentialId) ?? j.credentialId,
    };
  });
  const tunnels = parts.tunnels.map((t) =>
    importTunnel(t, credRemap, jumpRemap, t.id, t.name),
  );

  return {
    tunnels,
    credentials,
    jumpHosts,
    __counts: {
      credentials: { add: credentials.length, update: 0, conflict: 0 },
      jumpHosts: { add: jumpHosts.length, update: 0, conflict: 0 },
      tunnels: { add: tunnels.length, update: 0, conflict: 0 },
    },
  };
}

/**
 * MERGE: add new records, reuse a credential / jump-host label-collision (mapping
 * the bundle id onto the existing record so references still resolve), update a
 * record matched by id (never clobbering an existing secret with a stripped one),
 * and rename-and-add a tunnel whose name collides (so both are kept).
 */
function mergeDoc(parts, plainById, current) {
  const credentials = current.credentials.map((c) => ({ ...c }));
  const jumpHosts = current.jumpHosts.map((j) => ({ ...j }));
  const tunnels = current.tunnels.map((t) => ({ ...t }));

  const credRemap = new Map();
  const jumpRemap = new Map();
  const counts = {
    credentials: { add: 0, update: 0, conflict: 0 },
    jumpHosts: { add: 0, update: 0, conflict: 0 },
    tunnels: { add: 0, update: 0, conflict: 0 },
  };

  const idIndex = (arr, id) => arr.findIndex((x) => x && x.id === id);
  const labelIndex = (arr, key, val) =>
    arr.findIndex((x) => x && x[key] === val);
  const freeId = (arr, id) =>
    id && idIndex(arr, id) === -1 ? id : io.newUUID();

  // Credentials.
  for (const bc of parts.credentials) {
    const plain = plainById.get(bc.id);
    const byId = idIndex(credentials, bc.id);
    if (byId !== -1) {
      const sealed = sealImportedCredential(bc, plain, credentials[byId]);
      sealed.id = bc.id;
      credentials[byId] = sealed;
      credRemap.set(bc.id, bc.id);
      counts.credentials.update += 1;
      continue;
    }
    const byLabel = labelIndex(credentials, "label", bc.label);
    if (byLabel !== -1) {
      credRemap.set(bc.id, credentials[byLabel].id); // reuse existing, skip import
      counts.credentials.conflict += 1;
      continue;
    }
    const id = freeId(credentials, bc.id);
    const sealed = sealImportedCredential(bc, plain, undefined);
    sealed.id = id;
    credentials.push(sealed);
    credRemap.set(bc.id, id);
    counts.credentials.add += 1;
  }

  // Jump hosts (after credential remap so their credentialId resolves).
  for (const bj of parts.jumpHosts) {
    const credId = credRemap.get(bj.credentialId) ?? bj.credentialId;
    const byId = idIndex(jumpHosts, bj.id);
    if (byId !== -1) {
      jumpHosts[byId] = {
        id: bj.id,
        label: bj.label,
        host: bj.host,
        port: bj.port,
        credentialId: credId,
      };
      jumpRemap.set(bj.id, bj.id);
      counts.jumpHosts.update += 1;
      continue;
    }
    const byLabel = labelIndex(jumpHosts, "label", bj.label);
    if (byLabel !== -1) {
      jumpRemap.set(bj.id, jumpHosts[byLabel].id);
      counts.jumpHosts.conflict += 1;
      continue;
    }
    const id = freeId(jumpHosts, bj.id);
    jumpHosts.push({
      id,
      label: bj.label,
      host: bj.host,
      port: bj.port,
      credentialId: credId,
    });
    jumpRemap.set(bj.id, id);
    counts.jumpHosts.add += 1;
  }

  // Tunnels.
  for (const bt of parts.tunnels) {
    const byId = idIndex(tunnels, bt.id);
    if (byId !== -1) {
      tunnels[byId] = importTunnel(bt, credRemap, jumpRemap, bt.id, bt.name);
      counts.tunnels.update += 1;
      continue;
    }
    const nameTaken = labelIndex(tunnels, "name", bt.name) !== -1;
    const name = nameTaken ? uniqueName(bt.name, tunnels) : bt.name;
    const id = freeId(tunnels, bt.id);
    tunnels.push(importTunnel(bt, credRemap, jumpRemap, id, name));
    if (nameTaken) counts.tunnels.conflict += 1;
    else counts.tunnels.add += 1;
  }

  return { tunnels, credentials, jumpHosts, __counts: counts };
}

/** "name", "name (2)", "name (3)"… — the first that no existing tunnel holds. */
function uniqueName(base, tunnels) {
  const taken = new Set(tunnels.map((t) => t && t.name));
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ── SSH-config import commit ────────────────────────────────────────────────────

/**
 * Commit the selected hosts of an SSH-config import proposal (from ssh-config.js).
 * Reuses an existing credential / jump host with the same label (so a re-import
 * doesn't pile up duplicates), creates what's missing, and adds a tunnel per
 * selected host — all in ONE atomic write. Nothing but the selected closure is
 * touched; the proposal carries no secret (agent / key-by-path only).
 *
 * @param {import('./stores').Stores} stores
 * @param {object} args
 * @param {object} args.proposal  { credentials, jumpHosts, tunnels } with tempIds
 * @param {string[]} args.selected  tunnel tempIds the user chose
 * @returns {{ok:true, created:{credentials:number,jumpHosts:number,tunnels:number}}}
 */
function applySshProposal(stores, { proposal, selected } = {}) {
  const p = proposal || {};
  const propCreds = Array.isArray(p.credentials) ? p.credentials : [];
  const propJumps = Array.isArray(p.jumpHosts) ? p.jumpHosts : [];
  const propTunnels = Array.isArray(p.tunnels) ? p.tunnels : [];
  const chosen = new Set(Array.isArray(selected) ? selected : []);

  const selectedTunnels = propTunnels.filter((t) => chosen.has(t.tempId));
  if (selectedTunnels.length === 0) {
    return { ok: true, created: { credentials: 0, jumpHosts: 0, tunnels: 0 } };
  }

  // Dependency closure: the jump hosts + credentials the selected tunnels need.
  const jumpByTemp = new Map(propJumps.map((j) => [j.tempId, j]));
  const credByTemp = new Map(propCreds.map((c) => [c.tempId, c]));
  const neededJumps = new Set();
  const neededCreds = new Set();
  for (const t of selectedTunnels) {
    if (t.credentialTempId) neededCreds.add(t.credentialTempId);
    for (const jid of t.jumpHostTempIds || []) {
      neededJumps.add(jid);
      const jump = jumpByTemp.get(jid);
      if (jump && jump.credentialTempId) neededCreds.add(jump.credentialTempId);
    }
  }

  const doc = readDoc(stores.paths());
  const credentials = doc.credentials.map((c) => ({ ...c }));
  const jumpHosts = doc.jumpHosts.map((j) => ({ ...j }));
  const tunnels = doc.tunnels.map((t) => ({ ...t }));
  const created = { credentials: 0, jumpHosts: 0, tunnels: 0 };

  // Credentials: reuse an existing one with the same label, else create.
  const credRemap = new Map();
  for (const tempId of neededCreds) {
    const pc = credByTemp.get(tempId);
    if (!pc) continue;
    const existing = credentials.find((c) => c && c.label === pc.label);
    if (existing) {
      credRemap.set(tempId, existing.id);
      continue;
    }
    const incoming = { label: pc.label, user: pc.user, authType: pc.authType };
    if (pc.authType === "key" && pc.keyPath) incoming.keyPath = pc.keyPath;
    const sealed = sealCredential(incoming, undefined); // no secret to seal
    sealed.id = io.newUUID();
    credentials.push(sealed);
    credRemap.set(tempId, sealed.id);
    created.credentials += 1;
  }

  // Jump hosts: reuse by label, else create with the remapped credential.
  const jumpRemap = new Map();
  for (const tempId of neededJumps) {
    const pj = jumpByTemp.get(tempId);
    if (!pj) continue;
    const existing = jumpHosts.find((j) => j && j.label === pj.label);
    if (existing) {
      jumpRemap.set(tempId, existing.id);
      continue;
    }
    const id = io.newUUID();
    jumpHosts.push({
      id,
      label: pj.label,
      host: pj.host,
      port: pj.port || 22,
      credentialId: credRemap.get(pj.credentialTempId) ?? "",
    });
    jumpRemap.set(tempId, id);
    created.jumpHosts += 1;
  }

  // Tunnels: always add (rename on a name collision so nothing is clobbered).
  for (const pt of selectedTunnels) {
    const nameTaken = tunnels.some((t) => t && t.name === pt.name);
    const name = nameTaken ? uniqueName(pt.name, tunnels) : pt.name;
    tunnels.push({
      id: io.newUUID(),
      name,
      type: pt.type || "local",
      localPort: pt.localPort,
      destination: pt.destination,
      sshHost: pt.sshHost,
      sshPort: pt.sshPort || 22,
      bindHost: pt.bindHost || "127.0.0.1",
      credentialId: credRemap.get(pt.credentialTempId) ?? "",
      jumpHostIds: (pt.jumpHostTempIds || [])
        .map((jid) => jumpRemap.get(jid))
        .filter(Boolean),
      enabled: true,
    });
    created.tunnels += 1;
  }

  writeDoc(stores.paths(), { tunnels, credentials, jumpHosts });
  return { ok: true, created };
}

module.exports = {
  FORMAT,
  VERSION,
  PORTABLE_PREFIX,
  PORTABLE_SETTINGS_KEYS,
  isPortableSecret,
  sealPassphrase,
  openPassphrase,
  buildBundle,
  validateBundle,
  previewBundle,
  applyBundle,
  applySshProposal,
  // Re-exported so callers/tests can recognise every secret family in one place.
  SECRET_FIELDS,
  decryptCredential,
};
