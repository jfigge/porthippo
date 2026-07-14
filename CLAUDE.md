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
**Features 00–70 and 90 have landed:** the data model + encrypted store, the SSH tunnel
engine, monitoring/stats, the Definition + Monitoring views, CI/CD packaging, the app shell
(tray, hide-to-tray, launch-at-login, settings, native menu, logging/diagnostics, i18n), and
selectable secret storage (Settings → Security: device key / OS keychain / master password).
Remaining: docs (80). When a stage is finished, move its plan file into `features/done/`.

## Source Directories

- `src/app/` — Electron **main** process (Node.js, CommonJS): window lifecycle, IPC
  handlers (`ipc/`), storage (`store/`), and the SSH tunnel engine (`tunnel/`). All native
  I/O — sockets and SSH — lives here. Feature 60 adds the app-shell modules: `tray.js`,
  `tray-icon.js`, `menu.js`, `login-item.js`, `logger.js`, `diagnostics.js`, and `i18n.js`
  (main-side catalog loader).
- `src/web/` — **renderer** (Vanilla JS ES modules + CSS): UI. Sandboxed; talks to main
  only through `window.porthippo.*`.
- `src/web/fonts/` — bundled Inter variable font; never load fonts from a CDN.
- `src/web/locales/` — i18n catalogs (`en.json` shipped complete). English is also embedded
  in `src/web/scripts/i18n.js` as `EN` so `t()` resolves synchronously; a test keeps the two
  byte-identical — **regenerate `en.json` after editing `EN`** (see below).
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
  ├── App shell     (tray/menu/login-item)   tray, native menu, launch-at-login
  ├── Logging       (logger.js/diagnostics)  rotating log + redacted diagnostics report
  ├── i18n (main)   (src/app/i18n.js)         loads locale catalogs for menu/tray/dialogs
  ├── IPC handlers  (src/app/ipc/)           store.js + engine.js + dialog.js + shell.js
  └── IPC bridge    (src/app/preload.js)     →  window.porthippo.*
        └── Renderer / UI (src/web/scripts/app.js)
```

- The main process owns all filesystem I/O, sockets, and SSH (via `ssh2`). The renderer is
  sandboxed and communicates exclusively via `window.porthippo.*`.
- Request/response IPC channels are registered in `ipc/store.js` (CRUD + settings +
  `hostkeys:list|revoke`), `ipc/engine.js` (`tunnels:arm|disarm|status|pause|resume|apply`,
  `hostkeys:trust|reject`), `ipc/resolve.js` (`resolve:lookup|test|cancel` — Feature 100),
  `ipc/dialog.js` (`dialog:open-key-file`), `ipc/context-menu.js` (`menu:popup` — the
  native tunnel-row right-click menu), `ipc/shell.js`
  (`i18n:load`, `diagnostics:copy`) and `ipc/secret-storage.js`
  (`secret-storage:get-mode|set-mode|unlock|lock`), and exposed through `preload.js`; **keep
  the handler and the `window.porthippo.*` exposure in lockstep** (the `ipc-parity` test
  guards this — add any new `ipc/*.js` file to its scan list).
- Live state flows the other way as one-way `porthippo:*` broadcasts
  (`porthippo:tunnel-state`, `porthippo:hostkey-unknown`, `porthippo:hostkey-changed`,
  `porthippo:secret-storage-changed`):
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
- `resolve-check.js` + `ssh-chain.js` `probeChain` (Feature 100) — hostname-resolution
  validation. `lookupHost` is a plain local `dns.lookup` (bind host / first hop). `probeChain`
  walks the real chain and probes the destination from the far end via `direct-tcpip`
  (`forwardOut`) — reusing the same host-key verifier — to report a per-hop resolve/reach
  result; it is **protocol-only** (no remote command execution) and always disposes.
- `tunnel.js` — per-definition lifecycle: lazy connect on first access, ref-counted idle
  teardown after `lingerMs`, `keepAlive`, reconcile (pending edits / force-apply), and the
  `autoReconnect` drop policy (default off → re-establish on next access).
- `engine.js` — the singleton: `arm/disarm/armAll/disarmAll/status/apply/reconcile`,
  host-key prompt mediation, and `probeDefinition` (Feature 100 — a disposable resolution
  probe that reuses the host-key verifier but never binds a listener or tracks a tunnel).
  Reads decrypted definitions via `tunnelStore().getDecrypted()/listDecrypted()` (and
  `resolveDecrypted()` for a draft probe); never imports Electron (broadcasts are injected).

### App shell (Feature 60)

Port Hippo is a **background utility**, so the shell keeps tunnels alive:

- **Lifecycle — close hides, only Quit disarms.** The window `close` event hides to the tray
  (unless the module `isQuitting` flag is set); `window-all-closed` never quits on its own.
  The single Quit path (`requestQuit` — tray/menu/Cmd+Q, optionally confirmed) sets
  `isQuitting`, then `before-quit` runs `engine.disarmAll()`. **Never disarm on a plain window
  close.** A first-time hide shows a one-off "running in the tray" notification (persisted via
  the `trayHintSeen` setting).
- **Tray is the primary presence** (`tray.js`, macOS template glyph synthesised in
  `tray-icon.js`). It is fed by teeing the engine `broadcast` — `main.js` calls `tray.update()`
  on each `porthippo:tunnel-state` (not on the byte-rate `porthippo:stats` heartbeat).
- **Single-instance lock** in `main.js` (skipped under `--hot-reload`); a second launch focuses
  the running window.
- **Native menu** (`menu.js`) and **tray** take injected Electron (`Menu`/`Tray`/`app`) — they
  don't `require("electron")`. Custom items either call a main action directly (arm-all, quit,
  copy-diagnostics) or `webContents.send("menu:*")` → preload re-dispatches as a
  `porthippo:*` `CustomEvent` app.js binds.
- **Launch at login** (`login-item.js`): `setLoginItemSettings` on macOS/Windows, a
  `~/.config/autostart` `.desktop` on Linux. Applied (packaged builds only) via the
  `afterSettingsWrite` hook when the `launchAtLogin` setting changes.

### i18n (Feature 60)

- Renderer `src/web/scripts/i18n.js` exports `t(key, params)`, `formatNumber`, `formatDate`,
  `applyCatalog`, `init`, and the embedded English catalog `EN`. `t()` resolves synchronously
  against `EN`; `init()` (awaited once in `app.js`) layers the active locale over IPC
  (`window.porthippo.i18n.load`). Keys are flat `area.component.label`; `{name}` interpolates.
- Main `src/app/i18n.js` (`loadCatalog`/`readCatalog`/`label`/`format`) resolves labels for
  main-side chrome (menu/tray/dialogs) from `src/web/locales/<lang>.json`.
- **Single source of truth:** edit `EN` in the renderer module, then regenerate `en.json`:
  `cd src && node --input-type=module -e "import {EN} from './web/scripts/i18n.js'; import {writeFileSync} from 'node:fs'; writeFileSync('./web/locales/en.json', JSON.stringify(EN,null,2)+'\n')"`.
  A test asserts they stay byte-identical and that every renderer `t("…")` key exists in `EN`.

### Logging & diagnostics (Feature 60)

- `logger.js` — a dependency-free rotating file logger (`userData/logs/main.log`, 1 MB × 5)
  with a `console.*` tee installed first in `main.js`. Never hand it a secret.
- `diagnostics.js` — a pure `buildReport({app, tunnels, logs})` string builder for
  "Copy Diagnostics" (Help menu / tray / Settings). It reads the **sealed** tunnel list (no
  secret values) and passes the log tail through `redact()` (PEM keys, `password:`-style
  key/values, URL creds). **Secrets must never reach a report or the log** (tested).

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

- **Claude must not create commits.** Do not run `git commit` (or `git push`) — the user
  handles all committing and pushing themselves, even when a task is finished and verified.
  You may stage changes or draft a commit message when asked, but leave the actual commit
  to the user.
- **Never create a branch unless explicitly told to.** This is a solo project; work happens
  directly on the current branch (normally `main`). Do not auto-branch, even for large changes.
- When you draft a commit message, end it with the required `Co-Authored-By` trailer.

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
- The at-rest backend is **user-selectable** (Feature 90, Settings → Security): a promptless
  device **app key** (`enck:v1:`, the default so a fresh install raises no Keychain prompt),
  the **OS keychain** (`enc:v1:`, `safeStorage`), or a **master password** (`encm:v1:`,
  PBKDF2→AES-256-GCM; the key lives in memory only, so the mode boots **locked** and prompts
  to unlock). All crypto/keychain/migration lives in main (`store/{crypto,secret-storage}.js`);
  the renderer only sends mode/unlock intents and reacts to `porthippo:secret-storage-changed`.
- Switching backends **re-encrypts every stored secret** all-or-nothing (crash-safe: a durable
  migration marker, then the mode flip as the atomicity anchor, auto-finished on next launch).
  **No mode ever silently downgrades a secret to plaintext** — OS keychain is refused when
  `safeStorage` is unavailable, leaving a locked master password is refused, and the app-key
  file is deleted only after a completed switch away from it.
- Verify SSH host keys against `known_hosts` (trust-on-first-use with an explicit prompt);
  never auto-accept (Feature 20). The resolution probe (Feature 90 → 100) reuses this same
  TOFU path — an unknown key during a "Test resolution" prompts exactly as arming would.
- Hostname-resolution validation (Feature 100) is **protocol-only**: remote checks resolve
  via SSH `direct-tcpip`, never by executing a command on a remote host, and the renderer
  only ever sends a reference draft + hostnames — no secret leaves main.
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
