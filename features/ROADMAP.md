# Port Hippo — Implementation Roadmap

**Port Hippo** is a cross-platform desktop app that manages SSH tunnels. It binds a
local port, and **on first access to that port it automatically opens an SSH tunnel**
to a destination host/port (optionally through a chain of jump hosts), holds the
tunnel open while any connection is live, and **tears the SSH connection down once the
local port goes idle** — regardless of how long the listener has been bound. A tunnel
can be **paused** at any time without destroying it. The app is a single page with two
views — **Definition** and **Monitoring** — that the user can flip between or view
side-by-side.

It is built as a **native JS / Node.js / Electron** app (no UI framework), with the
same engineering setup as its sibling project **Rest Hippo**
(`/Users/jason/src/js/projects/resthippo`): a `Makefile`-driven build, `src/app`
(Electron main) + `src/web` (renderer) split, file-based encrypted storage,
electron-builder packaging signed/notarized in GitHub Actions, and a GitHub Pages
download site. External npm packages are used **only when necessary** — the one core
runtime dependency is **`ssh2`** (there is no built-in SSH in Node), plus
`electron-updater` for auto-update.

## How to use these plans
Each numbered file is one **stage**, written to be implemented **in order, one at a
time**. Every plan follows the Rest Hippo feature-doc shape — Context, Goal, settled
Design decisions, numbered Implementation steps, Acceptance criteria, Constraints, and
a Verify recipe. When a stage is finished and merged, move its file into
`features/done/` (the convention Rest Hippo uses). Later stages assume the earlier ones
have landed; each names its prerequisites in **Context**.

## Stages

| #  | Plan | What it delivers | Depends on |
|----|------|------------------|------------|
| 00 | [Project scaffold & build system](00-project-scaffold.md) | Repo layout, Makefile, `src/app`+`src/web` Electron shell, two-view skeleton, `window.porthippo` IPC bridge, lint/format/test/build/`make debug`, Apache-2.0 + license-header guard | — |
| 10 | [Tunnel data model & store](10-tunnel-data-model.md) | Tunnel-definition schema (local port, destination, SSH server, jump-host chain, auth), encrypted-at-rest file store, CRUD IPC, migrations, tests | 00 |
| 20 | [SSH tunnel engine](20-ssh-tunnel-engine.md) | The core: per-tunnel local listener, lazy on-demand SSH connect via `ssh2`, `forwardOut` relay with byte counting, connection ref-counting + linger teardown, multi-hop jump-host chaining, host-key verification, arm/disarm lifecycle | 10 |
| 30 | [Monitoring & stats](30-monitoring-and-stats.md) | Per-tunnel metrics (rates, totals, last-active, open time, connection count, state), throttled main→renderer stats stream, pause/resume without teardown | 20 |
| 40 | [Definition view (UI)](40-definition-view.md) | The two-view single-page shell + the Definition form: local port, destination, SSH server, auth picker, jump-host builder, validation, save/edit/delete, arm toggle | 30 |
| 50 | [Monitoring view (UI)](50-monitoring-view.md) | The Monitoring view: tunnel list (all/active toggle), live traffic rates, totals, last-active, open time, connection count, state badges, pause/resume + arm controls, split-view layout | 40 |
| 60 | [App shell: tray, settings & platform integration](60-app-shell-tray-and-settings.md) | System-tray presence, hide-to-tray (keep tunnels alive), launch-at-login, settings, native menus, notifications, logging/diagnostics, i18n seam | 50 |
| 70 | [CI/CD, packaging & website](70-cicd-packaging-and-website.md) | electron-builder targets for macOS/Windows/Linux × arm64/x64, signing + notarization, auto-update feed, GitHub Actions (CI, DCO, release, deploy-site), the GitHub Pages download site | 60 |
| 80 | [Docs & user guide](80-docs-and-user-guide.md) | In-app + hosted user guide (single Markdown source), README/CONTRIBUTING/SECURITY/NOTICE, export-compliance notes | 70 |
| 90 | [Selectable secret storage](90-selectable-secret-storage.md) | Rest Hippo's three at-rest backends made user-selectable — device key (no prompt, default), OS keychain, master password — with re-encrypt-all migration and a Security tab in the Settings dialog | 60 |
| 100 | [Hostname resolution validation](100-hostname-resolution-validation.md) | Live soft warnings when a bind host / first hop won't resolve locally, plus a **Test resolution** button that walks the real jump-host chain (reusing the engine + host-key TOFU) to validate each downstream hop and the destination from its correct vantage point — protocol-only, no secret leaves main | 20, 45 |

## Cross-cutting conventions (apply in every stage)
- **No UI framework.** Plain DOM + class-based ES modules; CSS via design tokens in
  `src/web/styles/theme.css`. Follow Rest Hippo's class-naming rule: `prefix-name`
  elements, `block--modifier` state — never bare `.selected`.
- **Process split.** All native I/O — sockets, SSH, filesystem, keychain — lives in the
  **main** process (`src/app`). The sandboxed renderer talks only over the
  `window.porthippo.*` IPC bridge; keep `main.js` handlers and `preload.js` exports in
  lockstep.
- **Events vs callbacks.** Parent-owned widget reporting to its creator → constructor
  callback; app-wide state change any number of panels may react to → a global
  `porthippo:*` `CustomEvent`. No event-bus library.
- **Security first.** Bind local listeners to `127.0.0.1` by default (LAN exposure is an
  explicit, warned opt-in). Encrypt stored passwords/passphrases at rest. Verify SSH
  host keys against `known_hosts` (trust-on-first-use with an explicit prompt); never
  auto-accept. Redact secrets from logs, diagnostics, and exports.
- **License headers.** Apache-2.0; every first-party `src/app`/`src/web` JS+CSS and
  build script carries the standard header, enforced by a guard in `make test`.
- **Green gate.** `make fmt && make lint && make test` must pass before a stage is done;
  each plan's Verify section also drives the real app via `make debug`.

## Naming & identity (use consistently across all stages)
- Product name **Port Hippo**; npm package `porthippo`; Electron `appId`
  `com.porthippo.app`; repo `github.com/jfigge/porthippo`.
- IPC bridge object **`window.porthippo`**; global renderer events prefixed
  **`porthippo:`**.
- App icon source `src/web/porthippo-icon.svg`; download site domain **porthippo.com**
  (via `website/CNAME`), falling back to the `*.github.io` Pages URL until the domain is
  configured.
