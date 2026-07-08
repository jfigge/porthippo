# Feature 90 — Selectable secret storage (device key / OS keychain / master password)

## Context
Port Hippo encrypts SSH passwords and key passphrases at rest, and already ships **two** of
Rest Hippo's three at-rest backends: an **app key** (`enck:v1:` — a random 256-bit key in a
`0600` file, the promptless default) and the **OS keychain** (`enc:v1:` — Electron
`safeStorage`). What's missing is the **user's ability to choose**, and the third backend, a
**master password**. As on Rest Hippo, the OS keychain is genuinely stronger but triggers an
**unwanted macOS Keychain prompt** — jarring for a freshly-downloaded background utility — so
the product needs the same escape hatch Rest Hippo settled on: a promptless device-key
default plus an explicit, informed choice in Settings.

This stage ports Rest Hippo's complete three-mode selectable secret storage into Port Hippo
and surfaces it as a **Security tab** in the Settings dialog.

**Prerequisite: Feature 60**, which introduces the `SettingsPopup` (renderer settings dialog
with a left-nav tab strip) and the `t()` / `src/web/locales/en.json` i18n seam this tab plugs
into. Builds on **Feature 10** (`crypto.js`, `secret-storage.js`, the encrypted store) and
composes with **Feature 20** (the tunnel engine already tolerates an undecryptable secret —
`ssh-chain.js` skips an `auth[]` method flagged `decryptError` — so a *locked* tunnel simply
can't use password/key auth until unlocked, with no crash). Reference implementation:
Rest Hippo's `src/app/store/{crypto,secret-storage}.js`, `main.js` secret-storage IPC, and
`src/web/scripts/components/{settings-popup,secret-storage-modal}.js`.

## Goal
In **Settings → Security** the user chooses how secrets are encrypted at rest: **This device
(no prompt)** — the default app key; **OS keychain** — `safeStorage`; or **Master password** —
a passphrase-derived key. Switching **re-encrypts every stored secret** to the new backend
(crash-safe, all-or-nothing). Master-password mode keeps secrets **locked until unlocked each
session**. No mode is ever silently downgraded to plaintext, and a lost/forgotten master
password is clearly warned as unrecoverable.

## Design decisions (settled — do not relitigate)
- **Three self-identifying ciphertext families**, dispatched on prefix so a mixed store stays
  readable while the needed key is loaded: `enck:v1:` (app key, **the default**), `enc:v1:`
  (OS keychain), `encm:v1:` (master password). Port these down from Rest Hippo's `crypto.js`;
  keep the app key as the promptless default — **that is what removes the download-time
  Keychain prompt**.
- **Master password = PBKDF2-HMAC-SHA256, 210,000 iterations → 32-byte key**, AES-256-GCM
  sealing (same `iv(12)|tag(16)|ct` wire format as the app-key family). The derived key lives
  **in memory for the session only**; the mode **boots locked** (key not loaded) and the
  renderer prompts to unlock. A fixed **verifier** constant sealed under the key proves a
  password (the GCM tag does the check). Rename Rest Hippo's verifier string to
  `porthippo:secret-storage:verifier:v1`. The KDF salt, iteration count, and verifier live in
  the existing unencrypted `secret-storage.json` config — **no new file/path** is needed.
- **A mode switch re-encrypts every secret, crash-safely.** Two passes: (1) **validate** —
  decrypt every secret under the current backend; any failure aborts having written nothing
  (also coalescing the one macOS Keychain prompt into a single preflight); (2) **convert** —
  re-seal each value to the target and write. Bracket with a durable **migration marker**
  (written before any convert) and a **mode flip** (the atomicity anchor) after; a crash
  between them is auto-finished on next launch by `resumeMigration()`. Use
  `crypto.reencryptValue(value, target)` (decrypt-by-prefix then reseal) — **never**
  `encryptString()`, which short-circuits on a foreign prefix.
- **The migration surface is one file.** Port Hippo's only secret-bearing file is
  `tunnels.json`; the sealed `{ enc }` values live at `sshServer.auth[].{password|passphrase}`
  and `jumps[].auth[].{password|passphrase}` (only `password`-type and `key`-type auth carry a
  secret; `agent` carries none). `reencryptAll` rewrites each `entry.<field>.enc` string in
  place. (Compare Rest Hippo's many collection/request/environment files — Port Hippo's scope
  is far smaller.)
- **Engine interaction is already benign; make unlock proactive.** Auto-arm-on-launch still
  binds listeners when locked (no secret needed); a connection that needs a locked secret
  fails cleanly until unlock. On a successful **unlock** or **mode switch**, the main process
  tells the `TunnelEngine` to **reconcile** enabled tunnels so they can (re)connect, and
  broadcasts `porthippo:secret-storage-changed`. Never block arming on the lock state.
- **UI is a tab in Feature 60's `SettingsPopup`, all inline.** A `data-panel="security"`
  section mirroring Rest Hippo: a three-option `radiogroup` with help text, inline
  master-password set/confirm fields under that option, a "locked" row with an unlock input,
  and a **switch-confirm** dialog before re-encrypting. Everything renders inside the settings
  dialog — never open a nested popup that would detach it. All strings route through `t()` /
  `en.json` (`settings.security.*`), adapted from Rest Hippo's copy and rebranded.
- **Never downgrade to plaintext silently.** Selecting OS keychain when `safeStorage` is
  unavailable is refused (`keychain-unavailable`); the app-key file is deleted only *after* a
  completed switch away from it; leaving master-password while locked is refused.

## Implementation steps
1. **`crypto.js` — add the master-password family.** Add `PREFIX_MASTER = "encm:v1:"` to
   `AT_REST_PREFIXES`; add `deriveKey(password, salt, iterations)` (`pbkdf2Sync`, sha256,
   32 bytes) and `PBKDF2_ITERATIONS = 210000`; add session state `setMasterKey(key)`,
   `lock()`, `isLocked()`; extend `configure({ mode, appKey, masterKey })`; add
   `reencryptValue(value, targetBackend)` (decrypt-by-prefix → `_rawEncryptTo`); add the
   `encm:` branches to `_rawEncryptTo` (throw `DecryptError("locked")` when no master key) and
   `decryptString`; add the `"locked"` reason to `DecryptError`; export
   `_aesGcmEncrypt`/`_aesGcmDecrypt`, `deriveKey`, `PBKDF2_ITERATIONS`, `reencryptValue`,
   `setMasterKey`, `lock`, `isLocked`.
2. **`secret-storage.js` — master-mode + migration.** Add `"master-password"` to `MODES`;
   `VERIFIER_PLAINTEXT = "porthippo:secret-storage:verifier:v1"`, `MASTER_SALT_LEN = 16`;
   `prepareMasterPassword(password)` → `{ key, kdf:{salt,iterations}, verifier }` and
   `verifyMasterPassword(password, config)` → key|null; the migration marker set
   (`markMigration` / `clearMigration` / `pendingMigration` / `resumeMigration`); and
   `reencryptAll(targetBackend)` (two-pass validate→convert) whose `_secretFiles()` yields the
   single `tunnels.json` entry with `collect`/`transform` over the four auth-secret locations.
   Extend `bootstrap()`: infer `encm:` **first** on a lost config, boot master-password mode
   **locked**, and auto-resume a crash-interrupted no-password migration.
3. **`paths.js`.** No new path required (KDF/verifier ride `secret-storage.json`). Confirm and
   document.
4. **IPC — `src/app/ipc/secret-storage.js`.** A `registerSecretStorageIPC({ ipcMain, getStores,
   getEngine, reloadRenderer, safeCall })` exposing `secret-storage:get-mode`
   (`{ mode, locked, available, hasPassword }`), `secret-storage:set-mode`
   (`{ mode, password? }` → `{ ok, reason?, failures? }`), `secret-storage:unlock`
   (`{ password }` → `{ ok, reason? }`), `secret-storage:lock` (`{ ok }`). On unlock/set-mode
   success: `resumeMigration`/flip as needed, then `getEngine().reconcileAll?.()` and
   broadcast `porthippo:secret-storage-changed`. Register in `main.js`; **add
   `ipc/secret-storage.js` to the `ipc-parity.test.js` scan list.**
5. **`preload.js`.** Add `window.porthippo.secretStorage.{ getMode, setMode, unlock(password),
   lock }` (mirror the channels; `unlock` wraps the bare password into `{ password }`).
6. **Renderer Security tab** in Feature 60's `settings-popup.js`: the `data-panel="security"`
   section + `#loadSecurityState`/`#onSecurityModeChange`/`#applyMode`/`#applyMasterPassword`/
   `#unlockMaster` methods, cached `#securityState`. Reuse/port a small secret-field
   mask/reveal for the password inputs. Add `settings.security.*` strings to `en.json`
   (heading, help, three mode labels+descriptions, set/confirm, warnings, unlock, switch
   confirm, and the `error.*` reasons), adapted + rebranded from Rest Hippo.
7. **Tests.** `crypto.test.js`: master-password round-trip, `reencryptValue` across all three
   families, `deriveKey` determinism, `isLocked`. New `secret-storage.test.js`: a
   `tunnels.json` fixture through `reencryptAll` (all three directions), `verifyMasterPassword`
   success/failure, and `resumeMigration` crash cases (no-password auto-resume; master-password
   `needs-unlock`; `failed` leaves the marker). A `secret-storage` IPC reason-shape test.
   `ipc-parity` covers the new channels. Fold into `make test`.
8. **License headers** on new files; update `CLAUDE.md` security posture (selectable backends,
   master-password lock/unlock, "no silent plaintext downgrade").

## Acceptance criteria
- Settings → Security offers **This device (no prompt)**, **OS keychain**, and **Master
  password**, with clear help text and the current mode reflected; OS keychain is disabled when
  `safeStorage` is unavailable.
- Switching modes **re-encrypts every stored secret** to the new backend and persists the
  choice; a failure to decrypt any secret **aborts the switch with nothing written** and
  reports it. A crash mid-switch is **auto-finished** on the next launch.
- Master-password mode **boots locked**; entering the correct password unlocks for the session
  and lets tunnels connect; a wrong password is rejected; the forgotten-password
  irrecoverability is warned before it's set.
- The default remains the **promptless device key**, so a fresh install/download raises **no
  Keychain prompt**.
- Locking, an unavailable keychain, and other refusals never downgrade a secret to plaintext.
- New tests pass; `make test` green; new files carry the license header.

## Constraints
- All crypto, keychain, and migration in **main**; the renderer only sends mode/unlock intents
  over `window.porthippo.secretStorage.*` and reacts to `porthippo:secret-storage-changed`.
- The renderer **never** receives a decrypted secret or key material — only mode/lock status.
- `reencryptAll` is all-or-nothing per switch; the mode flip is the atomicity anchor; delete
  the app-key file only after a completed switch away from it.
- Never log or surface secrets — machine-readable reason codes only.
- Strings via the `t()` seam (Feature 60) — no hardcoded display strings in new renderer code.

## Verify
`make fmt && make lint && make test`, then `make debug`: with a tunnel that has a stored
password, open Settings → Security and switch **This device → OS keychain** (observe the
single Keychain preflight prompt) and back, confirming the tunnel still connects after each
switch (secrets survived re-encryption). Switch to **Master password**, set one, quit and
relaunch: confirm the app boots **locked**, a password-needing tunnel can't connect until you
unlock, and unlocking lets it connect. Confirm a fresh profile in the default device-key mode
raises **no** Keychain prompt on first launch.
