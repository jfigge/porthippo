# Feature 00 — Project scaffold & build system

## Context
The repo currently holds only `README.md` and this `features/` folder. Everything else
must be created. This stage stands up the **skeleton** that every later stage builds on,
copying the proven engineering setup from Rest Hippo
(`/Users/jason/src/js/projects/resthippo`) but stripped to a Port-Hippo-sized shell —
no REST/OAuth/GraphQL machinery, no 7-locale i18n yet (that seam lands in Feature 60).
The reference project's layout is: a top-level `Makefile` orchestrating everything,
`src/package.json` holding both dependencies and the full electron-builder config,
`src/app/` for the Electron main process, `src/web/` for the renderer, `scripts/` for
build tooling, and a root `LICENSE`/`NOTICE` under Apache-2.0.

There is no SSH, tunnelling, storage, or real UI in this stage — just a launchable
Electron window with an empty two-view shell and a working `window.porthippo` IPC bridge,
so `make debug` opens the app and the toolchain (`fmt`/`lint`/`test`/`build`) is green
from commit one.

## Goal
A cloneable repo where `make install` then `make debug` launches a Port Hippo Electron
window showing an empty **Definition / Monitoring** two-view shell, `make build`
produces an unsigned macOS app bundle, and `make fmt && make lint && make test` all pass
— with the license-header guard already wired.

## Design decisions (settled — do not relitigate)
- **Mirror Rest Hippo's structure exactly** where it isn't domain-specific: top-level
  `Makefile`; `src/package.json` (deps + electron-builder `build` block); `src/app`
  (main) / `src/web` (renderer) split; `scripts/` for tooling; `data/` as the
  git-ignored dev `--user-data-dir`. Do **not** copy Rest Hippo's REST/OAuth/GraphQL/
  mock/keycloak code or Make targets.
- **No UI framework, ever.** Vanilla ES2022 modules + plain CSS custom properties. This
  is a hard, permanent constraint carried in `CLAUDE.md`.
- **Electron 42+**, Node ≥20 engine, CommonJS in `src/app` (like Rest Hippo's
  `require(...)` main), ES modules in `src/web`.
- **IPC namespace is `window.porthippo`.** One preload bridge; `main.js` handlers and
  `preload.js` exports stay in lockstep (a parity test is added in Feature 10 once there
  are channels worth checking — for now the bridge exposes `platform` and `getVersion`).
- **Apache-2.0 from day one**, with the license-header guard (`scripts/license-header.mjs`
  + `make test-license-headers`) ported verbatim from Rest Hippo and pointed at
  `src/app`, `src/web/scripts`, `src/web/styles`, and `scripts/`.
- **Tooling: ESLint 9 flat config + Prettier**, Node built-in test runner
  (`node --test`). No Jest/Mocha/webpack. `esbuild` is listed as a dev dep only if a
  later stage needs to vendor a browser bundle — not used yet.
- **Single-instance lock + hide-to-tray** are deferred to Feature 60; this stage's
  window quits the app on close (normal Electron default) to keep the shell trivial.

## Implementation steps
1. **Repo metadata & ignore.** Add root `LICENSE` (Apache-2.0) and `NOTICE`; a
   `.gitignore` covering `src/node_modules/`, `build/`, `dist/`, `data/`, `*.env`
   (keep `*.env.example`), `.DS_Store`. Add `dev.env.example` (empty scaffold for the
   shared dev-env pattern) and `CLAUDE.md` (project guide — see step 8).
2. **`src/package.json`.** `name: porthippo`, `version: 0.1.0`, `main: app/main.js`,
   `license: Apache-2.0`, author Jason Figge, `homepage`/`repository`
   `github.com/jfigge/porthippo`, `engines.node >=20`. Scripts: `start`, `dev`, `fmt`,
   `lint` (paths `web/scripts/**/*.js` + `app/**/*.js`). devDependencies: `electron`,
   `electron-builder`, `eslint`, `globals`, `prettier`. dependencies: leave the runtime
   set empty for now (`ssh2` lands in Feature 20, `electron-updater` in Feature 70). Add
   the electron-builder `build` block scaffold (appId `com.porthippo.app`, productName
   `Port Hippo`, `directories.output: dist`, `files` globbing `app/**` + `web/**` +
   `package.json`) — full multi-platform target matrix is completed in Feature 70.
3. **Makefile.** Port the Rest Hippo Makefile's *structure* (VERSION/COMMIT/BRANCH vars,
   `WORKSPACE`/`SRC_DIR`/`BUILD_DIR`/`DATA_DIR`, shared `dev.env` include+export,
   `.DEFAULT_GOAL := dmg`) and these targets only: `install` (`npm ci`), `debug`
   (`electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)`), `fmt`, `fmt-check`,
   `lint`, `license-headers`, `test-license-headers`, `test` (initially just
   `test-license-headers` + any unit tests), `build`/`build-mac` (electron-builder
   `--dir` unsigned), `dmg` (unsigned dmg), `clean`, `version`, `info`, `help`. Leave
   release/sign/notarize/dist/store targets for Feature 70.
4. **Main process shell (`src/app/main.js`).** Create the `BrowserWindow`
   (contextIsolation on, nodeIntegration off, `preload: preload.js`), load
   `web/index.html`, open DevTools under `--hot-reload`, standard
   `window-all-closed`/`activate` lifecycle. Register two trivial IPC handlers:
   `app:platform` → `process.platform`/arch, `app:version` → app version. Wire a hidden
   hot-reload watcher of `web/` (chokidar-free: `fs.watch`) that reloads the window — or
   omit and just document `make debug` reload via relaunch.
5. **Preload bridge (`src/app/preload.js`).** `contextBridge.exposeInMainWorld("porthippo", { platform, getVersion })`, each backed by `ipcRenderer.invoke`. This is the single
   seam every later stage extends.
6. **Renderer shell (`src/web`).** `index.html` (loads `styles/theme.css`,
   `styles/app.css`, and `scripts/app.js` as a module); `styles/theme.css` with the
   design-token starter set (color, spacing, radius, font vars — dark default + light
   override via `prefers-color-scheme`); `scripts/app.js` bootstrap that mounts a header
   with a **Definition | Monitoring** view toggle and two empty `<section>` placeholders,
   switching visibility on toggle. Bundle the Inter variable font under `src/web/fonts/`
   (no CDN). Add an app icon `src/web/porthippo-icon.svg` (a simple placeholder is fine;
   real icon + generated `.ico`/png set come in Feature 70).
7. **License-header tooling.** Port `scripts/license-header.mjs` (stamp + `--check`
   modes) with `ROOTS` = `src/app`, `src/web/scripts`, `src/web/styles`, `scripts`;
   stamp every file created above. `make test-license-headers` must pass.
8. **`CLAUDE.md`.** A Port-Hippo project guide modelled on Rest Hippo's: what the app is,
   the `src/app`/`src/web` split, key entry points, common `make` commands, the
   no-framework + class-naming + IPC-lockstep + Apache-header rules, and the git workflow
   ("solo project, commit on `main`, never auto-branch, push only when asked").
9. **Smoke test.** Add one trivial `node --test` (e.g. a pure helper under `src/app`) so
   `make test` exercises the runner, and confirm `.eslintrc`/flat-config + `.prettierrc`
   produce a clean `make lint && make fmt-check`.

## Acceptance criteria
- `make install && make debug` opens a Port Hippo window with a working
  Definition/Monitoring view toggle (both empty) and no console errors.
- The renderer can call `window.porthippo.platform` / `.getVersion()` and get real
  values over IPC.
- `make build` (or `make dmg`) produces an unsigned macOS artifact under
  `build/src/dist/`.
- `make fmt-check`, `make lint`, and `make test` (including `test-license-headers`) all
  pass; every first-party file carries the Apache-2.0 header.
- `CLAUDE.md`, `LICENSE`, `NOTICE`, `.gitignore`, and `dev.env.example` exist and are
  consistent with the naming in `ROADMAP.md`.

## Constraints
- No framework, no bundler-built renderer (plain `<script type="module">`), no CDN
  fonts/assets. Native I/O only in main; renderer only via `window.porthippo.*`.
- Do not port Rest Hippo's domain code, its i18n catalogs, or its release/store Make
  targets — those arrive in later stages.
- CSS via `theme.css` tokens; class naming `prefix-name` / `block--modifier`.
- Keep `main.js` handlers and `preload.js` exports in lockstep.

## Verify
`make install`, then `make fmt-check && make lint && make test` (all green). Run
`make debug`: confirm the window opens, the view toggle switches between the two empty
sections, and DevTools shows `window.porthippo.platform` returning your OS. Run
`make build` and confirm an unsigned app bundle appears under `build/src/dist/`. Finally
`make clean` and confirm build artifacts are removed.
