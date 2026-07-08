# Port Hippo — Project Guide for Claude

## What This Is

**Port Hippo** is a cross-platform desktop app that manages **SSH tunnels**. It binds a
local port and, **on first access to that port, automatically opens an SSH tunnel** to a
destination (optionally through a chain of jump hosts), holds it open while any connection
is live, and **tears the SSH connection down once the local port goes idle** — however long
the listener stays bound. Tunnels can be **paused** without being destroyed. The UI is a
single page with two views — **Definition** and **Monitoring** — flippable or shown
side-by-side.

Built with **Electron + Vanilla JavaScript + Node.js**, no UI framework. The engineering
setup mirrors its sibling project **Rest Hippo** (`../resthippo`).

## Status

Being built stage-by-stage from the plans in `features/` (see `features/ROADMAP.md`).
**Feature 00 (this scaffold) is landing:** a launchable window with an empty
Definition/Monitoring shell and a working `window.porthippo` bridge. SSH, storage, and the
real UI arrive in later features. When a stage is finished, move its plan file into
`features/done/`.

## Source Directories

- `src/app/` — Electron **main** process (Node.js, CommonJS): window lifecycle, IPC
  handlers (`ipc/`), storage (`store/`), and the SSH tunnel engine (`tunnel/`). All native
  I/O — sockets and SSH — lives here.
- `src/web/` — **renderer** (Vanilla JS ES modules + CSS): UI. Sandboxed; talks to main
  only through `window.porthippo.*`.
- `src/web/fonts/` — bundled Inter variable font; never load fonts from a CDN.
- `src/web/styles/` — `theme.css` (design tokens + reset) and `app.css` (shell). Use the
  tokens; don't hardcode colours/sizes.
- `scripts/` — build tooling (`license-header.mjs`; more in later features).
- `Makefile` — the authoritative list of dev/build/test commands.
- `src/package.json` — Node dependencies and the electron-builder `build` config.

Do **not** modify anything under `build/` or `src/node_modules/`.

## Architecture

```
Electron main process (src/app/main.js)
  ├── Store factory (src/app/store/)         encrypted definitions, settings, host keys
  ├── Tunnel engine (src/app/tunnel/)        listeners, SSH connections, byte relays
  ├── IPC handlers  (src/app/ipc/)           store.js + engine.js  →  ipcMain.handle
  └── IPC bridge    (src/app/preload.js)     →  window.porthippo.*
        └── Renderer / UI (src/web/scripts/app.js)
```

- The main process owns all filesystem I/O, sockets, and SSH (via `ssh2`). The renderer is
  sandboxed and communicates exclusively via `window.porthippo.*`.
- Request/response IPC channels are registered in `ipc/store.js` (CRUD + settings +
  `hostkeys:list|revoke`) and `ipc/engine.js` (`tunnels:arm|disarm|status|apply`,
  `hostkeys:trust|reject`), and exposed through `preload.js`; **keep the handler and the
  `window.porthippo.*` exposure in lockstep** (the `ipc-parity` test guards this — add any
  new `ipc/*.js` file to its scan list).
- Live state flows the other way as one-way `porthippo:*` broadcasts
  (`porthippo:tunnel-state`, `porthippo:hostkey-unknown`, `porthippo:hostkey-changed`):
  `main.js` sends via `webContents.send`; `preload.js` re-dispatches each as a global
  `CustomEvent` on `window`. Payloads are serializable and carry fingerprints only — never
  secrets.

### Tunnel engine (`src/app/tunnel/`, Feature 20)

A single `TunnelEngine` (created in `main.js`, `armAll()` on startup, `disarmAll()` on
`before-quit`) owns a `Map<id, Tunnel>`. Each `Tunnel` is a state machine
(`disarmed → listening → connecting → connected → …`, plus `error`). We own the local
socket and relay bytes ourselves — never shell out to the system `ssh`.

- `listener.js` — the local `net` listener bound on `bindHost:localPort`; structured
  `EADDRINUSE` / privileged-port errors.
- `ssh-chain.js` — connects the SSH chain (`jumps → sshServer`) by chaining `ssh2.Client`s
  through the `sock` option; per-hop auth (agent / key / password) via `authHandler`.
- `relay.js` — `forwardOut` + bidirectional pipe with byte counters (Feature 30 reads them).
- `host-verifier.js` — verifies each hop's key against `~/.ssh/known_hosts` + the accepted-
  keys store; TOFU-prompts on unknown, hard-rejects a changed key. Never auto-accepts.
- `tunnel.js` — per-definition lifecycle: lazy connect on first access, ref-counted idle
  teardown after `lingerMs`, `keepAlive`, reconcile (pending edits / force-apply), and the
  `autoReconnect` drop policy (default off → re-establish on next access).
- `engine.js` — the singleton: `arm/disarm/armAll/disarmAll/status/apply/reconcile` and
  host-key prompt mediation. Reads decrypted definitions via
  `tunnelStore().getDecrypted()/listDecrypted()`; never imports Electron (broadcasts are
  injected).

## Common Commands

```bash
make install   # Install npm dependencies (into src/node_modules)
make debug     # Run Electron with DevTools + hot-reload (primary dev workflow)
make fmt       # Format JS/CSS/HTML via Prettier
make fmt-check # Check formatting without writing
make lint      # Lint JS via ESLint
make test      # License-header guard + Node unit tests (node --test)
make build     # Build the Electron app for macOS (dir only, unsigned)
make dmg       # Build an unsigned macOS .dmg (bare `make` default)
make clean     # Remove build/ and dist/
```

## Git Workflow

- **Never create a branch unless explicitly told to.** This is a solo project — commit
  directly on the current branch (normally `main`). Do not auto-branch before committing,
  even for large changes.
- Commit and push only when the user asks.
- End commit messages with the required `Co-Authored-By` trailer.

## Tech Stack

- **Renderer**: Vanilla JS (ES2022 modules), plain CSS with custom-property design tokens.
- **Main process**: Node.js, Electron 42+ (CommonJS).
- **SSH transport**: `ssh2` (added in Feature 20) — we own the local socket and relay bytes
  ourselves (never shell out to the system `ssh` binary).
- **Build**: Makefile + npm + electron-builder.
- **Lint/format**: ESLint 9 (flat config, `src/eslint.config.js`) + Prettier (defaults).
- **Testing**: Node built-in test runner (`node --test`); jsdom for renderer components in
  later features.

## Coding Conventions

- **No framework** — plain DOM APIs and CSS. Do not introduce React, Vue, or similar, or an
  event-bus library.
- **No god files** — keep each module focused on a single responsibility. When a file starts
  accumulating unrelated concerns (or grows past a few hundred lines), split it along its
  seams rather than letting one file own everything. This applies to both main-process and
  renderer code.
- Components are class-based ES modules; follow the pattern in existing files.
- **CSS** uses the custom properties in `src/web/styles/theme.css` — use them, don't
  hardcode colours or sizes.
- **CSS class naming**: `prefix-name` for elements (flat, hyphen-delimited, e.g.
  `view-toggle-btn`, `app-header-icon`); `block--modifier` for state/variant (e.g.
  `view-toggle-btn--active`). Never bare state classes (`.active`, `.selected`). The `--`
  double-hyphen is reserved for modifiers (and for `--color-*`/`--space-*` token names).
- **Component ↔ app communication**: a parent-owned widget reporting to the one parent that
  created it → **constructor callback** (`this.#onSave?.(payload)`); an app-wide state
  change any number of panels may react to → a global **`porthippo:*` `CustomEvent`**. Pick
  by who needs to hear it.
- IPC channels registered in `main.js` are exposed through `preload.js` as
  `window.porthippo.*`; keep the two in lockstep.

## Security posture (this is a credential-handling app)

- Bind local listeners to `127.0.0.1` by default; LAN exposure is an explicit, warned
  opt-in (Feature 40).
- Encrypt stored passwords/passphrases at rest (Feature 10); the renderer never receives a
  decrypted secret.
- Verify SSH host keys against `known_hosts` (trust-on-first-use with an explicit prompt);
  never auto-accept (Feature 20).
- Redact secrets from logs, diagnostics, and any export.

## License headers

The project is **Apache-2.0** (`LICENSE` + `NOTICE` at the root; `"license":
"Apache-2.0"` in `src/package.json`). Every first-party source file must begin with the
standard Apache 2.0 header comment — a hard requirement enforced by a guard.

- **Scope**: first-party `*.js` under `src/app/` and `src/web/scripts/`, `*.css` under
  `src/web/styles/`, and the build scripts under `scripts/`.
- **Exempt**: `src/node_modules/`, and non-comment file types (`*.json`, `*.md`, `*.html`).
- **Enforcement**: `scripts/license-header.mjs --check` runs as `make test-license-headers`,
  part of `make test` (so CI fails on a missing header).
- **Auto-fix**: run `make license-headers` to stamp every in-scope file missing the header;
  it preserves shebangs and is idempotent.
