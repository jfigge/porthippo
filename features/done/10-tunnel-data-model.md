# Feature 10 — Tunnel data model & encrypted store

## Context
Feature 00 gives us a launchable shell with a `window.porthippo` bridge but no data. Before
we can build the SSH engine (Feature 20) or any UI (Features 40/50), we need a **durable,
typed model of a tunnel definition** and a place to keep it. Rest Hippo solves the same
problem with a file-based store under Electron's `userData` path (`src/app/store/`), with
atomic temp-then-rename writes, in-process write serialization, schema versioning +
migrations, and **encrypt-at-rest for secrets** (`src/app/store/secret-storage.js`,
`crypto.js`). Port Hippo reuses that architecture at a much smaller scale: a single
collection of tunnel definitions, plus an accepted-host-keys record and app settings.

The security stakes are higher here than in a REST client: a tunnel definition can carry
an SSH **password** or a key **passphrase**. Those must never sit in plaintext on disk.

## Goal
A main-process store that persists an ordered list of **tunnel definitions** — each fully
describing a local port, a destination host/port, an SSH server, an ordered jump-host
chain, and per-hop auth — with secrets encrypted at rest, exposed to the renderer through
CRUD IPC on `window.porthippo.tunnels.*`, and covered by unit tests.

## Design decisions (settled — do not relitigate)
- **One store module family under `src/app/store/`**, ported down from Rest Hippo:
  `io.js` (atomic read/write + write-queue), `crypto.js` (AES-GCM with a per-install key),
  `secret-storage.js` (key management: OS keychain when available via Electron `safeStorage`,
  falling back to a key file with clear "less secure" semantics), and a new
  `tunnel-store.js` (the domain store). Keep Rest Hippo's `schemaVersion` + `migrations`
  pattern.
- **The definition is one JSON record; secrets are isolated fields.** Passwords and
  passphrases live in dedicated `secret` fields that the store encrypts on write and
  decrypts only in main, never crossing IPC to the renderer in plaintext (the renderer
  gets a `hasSecret: true` flag, not the value — same "write-only secret" pattern Rest
  Hippo uses for auth credentials).
- **Auth is a discriminated union**, evaluated in the engine (Feature 20): `agent`
  (use the running SSH agent), `key` (`privateKeyPath` + optional encrypted `passphrase`),
  or `password` (encrypted). A hop may list **several** methods to try in order.
- **Jump hosts are an ordered array on the definition**, each element a full hop
  (`host`, `port`, `user`, `auth`) — the same shape as the target SSH server. The chain is
  `local → jumps[0] → jumps[1] → … → sshServer → destination`. Empty array = direct.
- **Bind host defaults to `127.0.0.1`.** A definition may set `bindHost` to `0.0.0.0` /
  a LAN address, but that is an explicit, later-warned choice (Feature 40 surfaces the
  warning). The store just stores it.
- **IDs are stable opaque strings** generated in main (`crypto.randomUUID()`); order is an
  explicit `order` index (like Rest Hippo's `tree.json` ordering) so the UI list is stable.
- **No database.** Plain JSON files under `userData`, atomic writes — matching Rest Hippo.

## Tunnel definition shape (reference)
```jsonc
{
  "id": "uuid",
  "name": "prod db",
  "enabled": true,                 // "armed" — engine binds the listener when true
  "order": 0,
  "localPort": 5432,
  "bindHost": "127.0.0.1",         // default loopback
  "destination": { "host": "db.internal", "port": 5432 },
  "sshServer": {                   // the tunnel-terminating SSH host
    "host": "bastion.example.com",
    "port": 22,
    "user": "jason",
    "auth": [{ "type": "agent" }]  // or {type:"key", privateKeyPath, passphrase?}
  },                               // or {type:"password", password}
  "jumps": [ /* zero or more hops, same shape as sshServer */ ],
  "lingerMs": 10000,               // idle grace before SSH teardown (Feature 20)
  "keepAlive": false,              // if true, connect eagerly & never idle-teardown
  "schemaVersion": 1
}
```
Secret fields (`auth[].passphrase`, `auth[].password`) are stored as
`{ "enc": "<base64 ciphertext>" }`, never plaintext.

## Implementation steps
1. **Port the storage primitives.** Bring `io.js`, `crypto.js`, and `secret-storage.js`
   over from Rest Hippo's `src/app/store/`, trimming anything REST-specific. Confirm the
   secret key is created under `userData` on first run (keychain-backed where possible).
2. **`tunnel-store.js`.** A class owning `tunnels.json` under `userData`: `list()`,
   `get(id)`, `create(def)`, `update(id, patch)`, `delete(id)`, `reorder(ids[])`. On
   write, encrypt secret fields via `crypto.js`; on read for the renderer, strip secrets
   to `hasSecret` booleans; on read for the engine (in-process), decrypt. Serialize writes
   through `io.js`'s queue. Stamp `schemaVersion` and run `migrations` on load.
3. **Validation.** A pure `validateDefinition(def)` (its own module + unit test): port in
   1–65535, host non-empty, destination present, each auth entry well-formed, jump chain
   entries valid, `lingerMs` ≥ 0. Return structured errors keyed by field so Feature 40 can
   show them inline.
4. **Accepted host keys store.** A small `known-hosts-store.js` (`get(hostPort)`,
   `trust(hostPort, fingerprint)`, `list()`, `revoke()`) persisting fingerprints the user
   has accepted — consumed by the engine's host-key verifier (Feature 20). Kept separate
   from `~/.ssh/known_hosts` (which the engine also reads); this holds Port-Hippo-accepted
   TOFU entries.
5. **Settings store.** A minimal `settings-store.js` (`get()/set(patch)`) for app-wide
   prefs — theme, default `lingerMs`, default `bindHost`, launch-at-login (used later by
   Feature 60). Same JSON-under-userData pattern.
6. **IPC + preload.** Register `tunnels:list/get/create/update/delete/reorder`,
   `settings:get/set`, and `hostkeys:list/revoke` handlers in a new
   `src/app/ipc/store.js` (called from `main.js`), and expose them under
   `window.porthippo.tunnels.*`, `.settings.*`, `.hostkeys.*` in `preload.js`. Keep the two
   files in lockstep.
7. **IPC parity test.** Add `src/app/tests/ipc-parity.test.js` (ported from Rest Hippo)
   asserting every channel handled in main is exposed in preload and vice-versa. Wire it
   into `make test`.
8. **Store unit tests.** `tunnel-store.test.js` (CRUD, ordering, secret round-trip:
   plaintext in → ciphertext on disk → plaintext back only in main, `hasSecret` to
   renderer), `crypto.test.js`, `validate.test.js`, `migrations.test.js`. Add
   corresponding `test-*` Make targets and fold them into `test`.
9. **License headers** on every new file (`make license-headers`).

## Acceptance criteria
- A tunnel definition can be created, listed, updated, reordered, and deleted through
  `window.porthippo.tunnels.*`, surviving an app restart.
- A password/passphrase written into a definition is stored **encrypted** on disk
  (grep the JSON: no plaintext secret), and the renderer-facing read exposes only
  `hasSecret: true` — never the value.
- Invalid definitions are rejected by `validateDefinition` with field-keyed errors.
- The known-hosts and settings stores persist and read back correctly.
- The IPC parity test passes; `make test` (all store tests) is green; all new files carry
  the license header.

## Constraints
- Native crypto/filesystem only in **main**; the renderer never sees a decrypted secret.
- No external DB or ORM; plain JSON + atomic writes via the ported `io.js`.
- Keep `main.js`/`ipc/store.js` handlers and `preload.js` exports in lockstep.
- Secret fields never appear in logs, diagnostics, or any future export (redact).
- Reuse Rest Hippo's `crypto`/`secret-storage`/`io` rather than inventing new ones.

## Verify
`make fmt && make lint && make test`. Then in `make debug`, from DevTools:
`await window.porthippo.tunnels.create({...})` a definition with a `password` auth,
restart the app, and confirm `tunnels.list()` returns it with `hasSecret:true` and no
plaintext password. Inspect `data/tunnels.json` (the dev user-data dir) and confirm the
secret is ciphertext. Create an invalid definition (port 99999) and confirm the validation
error.
