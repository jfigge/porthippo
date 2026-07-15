# Feature 120 — Import & export (SSH config import + encrypted backup/restore)

## Context

Depends on: **10/45** (definition model: tunnels + reusable credentials + jump hosts),
**90** (selectable secret storage + the `store/crypto.js` / `store/secret-storage.js`
envelope primitives). No engine changes.

Everything a user builds — tunnels, reusable credentials, jump-host chains — lives only in
`userData/tunnels.json`, sealed under the local machine's chosen backend (`enck:`/`enc:`/
`encm:` prefixes). There is no way to **move a setup to another machine**, **back it up**,
or **seed Port Hippo from an existing `~/.ssh/config`** — so a new install starts empty and
every tunnel is retyped by hand. This is the highest-value quality-of-life gap after
forwarding types.

The sealed on-disk secrets are deliberately **not portable** (a device key or OS-keychain
blob won't decrypt anywhere else — that's the security design), so export needs its own
**portable secret envelope** independent of the at-rest backend.

## Goal

A round-trippable **`.porthippo` bundle** — tunnels + credentials + jump hosts (and,
opt-in, app settings) — that can be exported and re-imported on another machine, with
secrets **either stripped** (default) **or sealed under a user passphrase** (opt-in,
`encp:v1:` PBKDF2→AES-256-GCM, independent of the device backend). Plus a **read-only
`~/.ssh/config` importer** that proposes credentials, jump hosts, and tunnel drafts for the
user to review before anything is written. All parsing/crypto in main; the renderer only
picks files and reviews the proposed diff.

## Design decisions (settled — do not relitigate)

- **The bundle is a versioned, self-describing document**, never the raw `tunnels.json`:
  `{ format: "porthippo-bundle", version: 1, exportedAt, contents: { tunnels[],
  credentials[], jumpHosts[], settings? }, secrets: "stripped" | "encp:v1" }`. Referential
  integrity (credentialId / jumpHostId) is preserved; ids are regenerated on import only on
  a collision (see merge).
- **Secrets never leave in a backend-sealed form.** Export **unseals** each secret in main,
  then either drops it (`secrets: "stripped"` — the default; the imported credential lands
  needing its password re-entered) or re-seals it under a **portable passphrase envelope**
  (`encp:v1:` = PBKDF2-HMAC-SHA256 → AES-256-GCM, salt+iv+params in the blob), gated behind
  an explicit passphrase prompt and a clear warning. **A plaintext secret is never written to
  disk**, and the device/OS-keychain sealed blob is never copied verbatim into a bundle.
- **Import re-seals under the local backend.** On import, an `encp:` secret is decrypted with
  the supplied passphrase and immediately re-sealed with the local machine's active backend
  (via the existing `secret-storage.js`), so the imported store matches every other secret
  on that machine. A stripped bundle imports credentials in a "needs secret" state that the
  editor flags.
- **Import is a reviewed merge, never a silent overwrite.** The renderer shows a preview
  (add / update / conflict per record, matched by id then by label) with a mode choice:
  **Merge** (default — add new, skip or rename label-collisions, never clobber an existing
  secret with a stripped one) or **Replace** (wipe and load the bundle, behind a confirm).
  A dangling reference in the bundle fails the import closed with a clear error (never a
  half-applied store).
- **SSH-config import is propose-only and read-only.** `ssh-config.js` parses the standard
  subset — `Host`, `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump` (+ `Include`) —
  from a user-chosen file (default `~/.ssh/config`), maps each `Host` to a credential
  (agent/key by `IdentityFile`) and, when `ProxyJump` is present, jump hosts, and drafts a
  tunnel per host. **Nothing is written until the user selects entries and confirms.** We
  never read a private key's *contents*, only its path; passwords are never invented.
- **Everything is a bundle operation in main.** New `store/portable.js` (build/apply +
  `encp:` envelope) and `store/ssh-config.js` (parser) with no Electron imports; file
  open/save uses `ipc/dialog.js`. The renderer sends intents and renders the preview.

## Bundle shape (reference)

```jsonc
{
  "format": "porthippo-bundle", "version": 1,
  "exportedAt": 1720300000000,
  "secrets": "stripped",              // or "encp:v1"
  "contents": {
    "tunnels":     [ /* reference tunnels, no inline secrets */ ],
    "credentials": [ /* label,user,authType,keyPath?, password?: "encp:v1:…" | omitted */ ],
    "jumpHosts":   [ /* label,host,port,credentialId */ ],
    "settings":    { /* opt-in, secret-free subset */ }
  }
}
```

## Implementation steps

1. **`store/portable.js`.** `buildBundle({ include, secretMode, passphrase? })` reads the
   decrypted definitions, applies the secret policy, returns the bundle object;
   `applyBundle(bundle, { mode, passphrase? })` validates, resolves the merge/replace,
   re-seals secrets under the local backend, and writes atomically (reusing `io.js`'s durable
   write). Add the `encp:v1:` seal/open beside the existing envelopes (share PBKDF2 params
   with the `encm:` master-password path so there's one KDF).
2. **`store/ssh-config.js`.** A dependency-free tokenizer for the config subset above
   (case-insensitive keywords, `Host` globs kept literal, `Include` expansion with a depth
   cap, `~` expansion), returning `{ hosts: [...] }`; a mapper to proposed
   `{ credentials, jumpHosts, tunnels }` drafts. Pure and unit-tested against fixtures.
3. **IPC + preload.** `portable:export` (→ dialog save), `portable:preview` (parse a chosen
   bundle → the add/update/conflict diff), `portable:import` (apply with a mode),
   `sshconfig:scan` (parse a chosen config → proposed drafts), `sshconfig:import` (commit the
   selected drafts). Register in a new `ipc/portable.js`, expose under `window.porthippo.io.*`,
   keep preload in lockstep, and **add `ipc/portable.js` to the `ipc-parity` scan list**. Each
   commit triggers `engine.reconcileAll()`.
4. **Renderer — Import/Export.** A new **Data** section in the Settings dialog (or a dedicated
   `import-export-dialog.js`): Export (choose contents + secret mode + passphrase), Import a
   bundle (show the preview, pick Merge/Replace, enter passphrase if `encp:`), and Import from
   SSH config (file pick → a checkbox list of proposed hosts → commit). Credentials imported
   without a secret are visibly flagged "needs password" in the credential picker/editor.
5. **i18n + docs.** Add labels/warnings to `EN`, regenerate `en.json`. Add a
   `docs/import-export.md` page (export/backup, moving to a new machine, SSH-config import,
   the security note on portable secrets) and register it in **both** `docs-viewer.js` and
   `build-docs.mjs` `PAGES`.
6. **Tests + headers.** `portable.test.js` (round-trip stripped and `encp:`; merge vs replace;
   dangling-ref rejection; a stripped import never clobbers an existing secret),
   `ssh-config.test.js` (fixture parse incl. `ProxyJump` + `Include`), and an `ipc-parity`
   update. Fold into `make test`; header-stamp new files.

## Acceptance criteria

- Export produces a `.porthippo` bundle; re-importing it on a **fresh** profile reproduces the
  tunnels, credentials, and jump hosts with references intact.
- With **stripped** secrets, imported credentials arm only after the user re-enters passwords;
  with an **`encp:` passphrase** bundle, the same passphrase on import restores secrets, which
  are then re-sealed under the local backend.
- A wrong passphrase fails cleanly (no partial write); a bundle with a dangling reference is
  rejected whole.
- SSH-config import proposes credentials/jump hosts/tunnels from a real `~/.ssh/config` and
  writes **only** the entries the user selects; no private-key contents are ever read.
- No plaintext secret is ever written to disk; diagnostics/logs stay secret-free; `make fmt &&
  make lint && make test` green.

## Constraints

- No new dependency — the parser and the `encp:` envelope are ours (reuse `crypto.js`).
- Export/import and SSH-config parsing live entirely in main; the renderer sends intents and
  renders previews only.
- Never silently overwrite: import is a reviewed merge or an explicitly-confirmed replace.
- `encp:v1:` is a distinct prefix from `enck:`/`enc:`/`encm:` and is never accepted as an
  at-rest backend — it exists only inside a bundle.

## Verify

```
make fmt && make lint && make test
make debug   # export a bundle (stripped) → import on a clean userData → tunnels reappear,
             # credentials flagged "needs password". Repeat with an encp: passphrase and
             # confirm secrets restore and re-seal. Import a sample ~/.ssh/config with a
             # ProxyJump and confirm the proposed credential + jump host + tunnel, commit a
             # subset, and arm one of them.
```
