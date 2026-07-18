# Jump Hippo — Implementation Roadmap

**Jump Hippo** is a cross-platform desktop app that manages SSH tunnels. It binds a
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
| 00 | [Project scaffold & build system](00-project-scaffold.md) | Repo layout, Makefile, `src/app`+`src/web` Electron shell, two-view skeleton, `window.jumphippo` IPC bridge, lint/format/test/build/`make debug`, Apache-2.0 + license-header guard | — |
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

## Priority backlog (planned, in priority order)

Eight new stages, written after 00–100 landed. Listed most-valuable first; numbered on the
by-tens convention. Each names its prerequisites in **Context** and is independent of the
others except where noted.

| #  | Plan | What it delivers | Depends on |
|----|------|------------------|------------|
| 110 | [Reverse & dynamic forwarding](110-forwarding-types.md) | A `type` on each tunnel — **local** (today), **remote** (`ssh -R`, bind a port on the far end), **dynamic** (`ssh -D`, a local SOCKS5 proxy) — reusing the host-key TOFU + stats paths; closes the biggest capability gap. No new dependency (we own the SOCKS5 handshake) | 20, 30, 45 |
| 120 | [Import & export](120-import-export.md) | A round-trippable `.jumphippo` bundle (tunnels + credentials + jump hosts) with secrets stripped or sealed under a portable passphrase (`encp:v1:`), reviewed merge/replace import, and a read-only `~/.ssh/config` importer that proposes drafts | 10, 45, 90 |
| 130 | [Failure notifications & health](130-failure-notifications-and-health.md) | Desktop notifications on drop/recover/give-up (coalesced, opt-out), ssh2 keepalive probing, a configurable reconnect policy (per-tunnel override), a reconnect countdown in Monitoring, and a tray health rollup — surfacing the engine's existing backoff, not rewriting it | 20, 30, 50, 60 |
| 140 | [Tunnel groups & bulk actions](140-tunnel-groups.md) | A reusable `group` (label + colour + order) with optional single membership, collapsible grouped lists with arm/pause-all headers, multi-select bulk actions, and per-group tray submenus; the engine stays group-unaware (bulk = id-set calls) | 45, 50, 60 |
| 150 | [Scheduling & auto-arm](150-scheduling-and-auto-arm.md) | Optional per-tunnel/group **rules** — a time window and/or a network trigger (SSID allow-list / reachability probe) — evaluated by a main-side, edge-triggered scheduler that respects manual override; all detection local, read-only, fail-safe | 20, 30, 60, 140 |
| 160 | [Activity history & trends](160-activity-history-and-trends.md) | Promote the ephemeral per-tunnel event log to a persistent, capped, redacted on-disk activity log (typed events), plus bounded downsampled metrics history driving hand-rolled SVG sparklines/trends in Monitoring — no chart library, secret-free | 30, 50, 60 |
| 170 | [Per-hop status in the route breadcrumb](170-hop-status-breadcrumbs.md) | **(Deferred — see plan)** The detail-panel route breadcrumb shows each hop's live state — up / down / connecting / idle — encoded by **shape** (tick / cross / pulse) as well as colour, with a failed node's reason on hover and to assistive tech; the engine reports secret-free per-hop facts on the existing `tunnel-state` broadcast and the renderer maps them onto its display nodes | 20, 30, 45, 100 |
| 180 | [Multi-language support](180-multi-language-support.md) | Ship six translated catalogs — French, German, Spanish, Simplified Chinese, Japanese, Italian — over Feature 60's already-complete i18n seam: additive `locales/*.json` + picker rows + a system CJK font fallback + a parity test that forbids a translation drifting from `EN`; no seam, schema, or IPC change | 60 |
| 190 | [Security-scoped bookmarks for key files (MAS)](190-security-scoped-key-bookmarks.md) | Make a user-picked SSH private key survive a relaunch in the Mac App Store sandbox — mint + persist an app-scoped security bookmark per key path, bracket every key read with start/stop-accessing, and inject the scoped reader into the engine (Electron-free); MAS-only, self-healing on a stale bookmark, never exported | 20, 90 |

## Cross-cutting conventions (apply in every stage)
- **No UI framework.** Plain DOM + class-based ES modules; CSS via design tokens in
  `src/web/styles/theme.css`. Follow Rest Hippo's class-naming rule: `prefix-name`
  elements, `block--modifier` state — never bare `.selected`.
- **Process split.** All native I/O — sockets, SSH, filesystem, keychain — lives in the
  **main** process (`src/app`). The sandboxed renderer talks only over the
  `window.jumphippo.*` IPC bridge; keep `main.js` handlers and `preload.js` exports in
  lockstep.
- **Events vs callbacks.** Parent-owned widget reporting to its creator → constructor
  callback; app-wide state change any number of panels may react to → a global
  `jumphippo:*` `CustomEvent`. No event-bus library.
- **Security first.** Bind local listeners to `127.0.0.1` by default (LAN exposure is an
  explicit, warned opt-in). Encrypt stored passwords/passphrases at rest. Verify SSH
  host keys against `known_hosts` (trust-on-first-use with an explicit prompt); never
  auto-accept. Redact secrets from logs, diagnostics, and exports.
- **License headers.** Apache-2.0; every first-party `src/app`/`src/web` JS+CSS and
  build script carries the standard header, enforced by a guard in `make test`.
- **Green gate.** `make fmt && make lint && make test` must pass before a stage is done;
  each plan's Verify section also drives the real app via `make debug`.

## Naming & identity (use consistently across all stages)
- Product name **Jump Hippo**; npm package `jumphippo`; Electron `appId`
  `com.jumphippo.app`; repo `github.com/jfigge/jumphippo`.
- IPC bridge object **`window.jumphippo`**; global renderer events prefixed
  **`jumphippo:`**.
- App icon source `src/web/jumphippo-icon.svg`; download site domain **jumphippo.com**
  (via `website/CNAME`), falling back to the `*.github.io` Pages URL until the domain is
  configured.
