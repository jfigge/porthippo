# Feature 70 — CI/CD, packaging & download website

## Context
Port Hippo now works end-to-end locally. This stage makes it **shippable**: signed,
notarized, auto-updating installers for **all major OSes in both arm64 and x64**, built and
published by **GitHub Actions**, with a **GitHub Pages** download site — exactly the
pipeline Rest Hippo runs (`.github/workflows/{ci,dco,release,deploy-site}.yml`, the
electron-builder `build` block in `src/package.json`, the `packaging/` entitlements, the
`release` Makefile target, and the `website/` folder). We port that pipeline, adjusting
identifiers to Port Hippo and dropping Rest-Hippo-specific bits (mock server, Keycloak,
store-build/MAS gating can be deferred).

Feature 00 stubbed the electron-builder `build` block and the local build targets; this
stage completes the target matrix, signing, notarization, auto-update, the release flow,
and CI, then stands up the site.

## Goal
Tagging a release builds signed + notarized installers for macOS (dmg/zip, arm64 + x64),
Windows (nsis + portable, arm64 + x64), and Linux (AppImage + deb, arm64 + x64), publishes
them to a GitHub Release with an auto-update feed, and refreshes the GitHub Pages download
site — all gated behind a green CI (lint, format, tests) and DCO check.

## Design decisions (settled — do not relitigate)
- **electron-builder, full matrix.** Complete the `build` block in `src/package.json`:
  `mac` (dmg + zip, arm64 + x64; hardenedRuntime, entitlements, `notarize:true`), `win`
  (nsis + portable, x64 + arm64), `linux` (AppImage + deb, x64 + arm64), `publish` →
  `github` (owner `jfigge`, repo `porthippo`), `artifactName` `Port-Hippo-${version}-${arch}.${ext}`. Port `packaging/entitlements.mac.plist`. Mac App Store / Microsoft Store
  packaging is **explicitly deferred** (a later feature) — ship direct-download first.
- **electron-updater for auto-update.** Add it as a runtime dep; port Rest Hippo's
  `updater.js`; the GitHub Release provides the update feed (electron-builder emits
  `latest*.yml`). Update checks are user-visible and non-forced.
- **Signing/secrets via the Makefile + repo secrets.** Port the `release.env` /
  `RELEASE_ENV_VARS` export discipline (export-if-non-empty so an empty `CSC_LINK` never
  breaks a build), the `dmg`/`sign-dmg`/`dist-*` targets, `staple-dmg` (sign+notarize+staple
  the dmg), and `sync-mac`/`sync-win` (push local creds to GitHub secrets). Absent creds ⇒
  unsigned artifacts, never a failure.
- **`make release VERSION=x.y.z`** ported: validate semver, require clean `main` in sync
  with origin, run `make test`, bump `src/package.json` + the website version placeholders,
  fast-forward a `release` branch, tag `vX.Y.Z`, atomic push (tag push triggers the build).
- **Four workflows, pinned by SHA** (Rest Hippo's security posture): `ci.yml` (lint +
  fmt-check + test on every push/PR, plus a packaging smoke-build), `dco.yml` (sign-off
  check), `release.yml` (matrix build on native runners → sign/notarize → publish Release →
  dispatch deploy-site), `deploy-site.yml` (build + publish the Pages site on push to
  `main` and post-release). Least-privilege `permissions:`; SHA-pinned actions.
- **The site is static + generated.** Port `website/` (index/download/features/privacy),
  `scripts/build-versions.mjs` (reads GitHub Releases → `versions.json`), and the
  auto-detect download logic (`downloads.js`) that offers the right OS/arch build.
  `website/CNAME` = `porthippo.com` (falls back to the `*.github.io` URL until DNS exists).
- **Native runners per platform.** macOS artifacts on `macos-latest`, Windows on
  `windows-latest` (MSYS2 for `make`), Linux on `ubuntu-latest` — cross-building is not
  attempted. CI's smoke-build may run Linux-only to save minutes (Rest Hippo does this),
  with the full matrix in `release.yml`.

## Implementation steps
1. **Complete the electron-builder `build` block** in `src/package.json` (targets, arches,
   signing, publish, artifact names) and port `packaging/entitlements.mac.plist`. Add
   `electron-updater` to `dependencies` and port `src/app/updater.js`; wire an update check
   into the app (menu/tray) + `porthippo:update-*` events.
2. **App icons.** Add `scripts/make-icons.mjs` (port) to generate the Windows `.ico`, macOS
   `.png`/icns, and Linux icon set from `src/web/porthippo-icon.svg`; commit outputs;
   reference them in the `build` block.
3. **Complete the Makefile release/dist targets.** Port `release.env`/`RELEASE_ENV_VARS`
   handling, `UNSIGNED_ENV`, `dmg`/`sign-dmg`/`sign-all`, `dist`/`dist-mac`/`dist-linux`/
   `dist-win`, `staple-dmg`, `sync-mac`/`sync-win`, and `make release`. Add
   `release.env.example`. Update `make help`.
4. **`ci.yml`.** Lint + `fmt-check` + `test` on ubuntu; a packaging smoke `build-linux`
   (matrix ready to re-enable mac/win). SHA-pinned actions, `permissions: contents: read`,
   concurrency-cancel, Node 22, npm cache on `src/package-lock.json`.
5. **`dco.yml`.** Port the sign-off check; add the `DCO` file and mention it in
   `CONTRIBUTING.md` (fleshed out in Feature 80).
6. **`release.yml`.** Triggered on `v*` tags: `check` (reuse CI gates) → matrix build on
   native runners with signing/notarization secrets → `electron-builder --publish always`
   to the GitHub Release → after publish, `workflow_dispatch` deploy-site. Handle secrets
   exactly as Rest Hippo (CSC_LINK, APPLE_*, WIN_CSC_*); absent ⇒ unsigned.
7. **`deploy-site.yml`.** Port verbatim (no `paths:` filter, no `release:` trigger — the
   dispatch from release.yml handles post-release): generate `versions.json`, build any
   hosted docs (Feature 80), configure + upload + deploy Pages.
8. **Website.** Port `website/` and rebrand to Port Hippo: `index.html` (hero + auto-detect
   download button via `downloads.js`), a features page, `versions.json` (generated),
   `CNAME`, `favicon.svg`, `robots.txt`/`sitemap.xml`. `scripts/build-versions.mjs` reads
   the repo's Releases.
9. **Secrets + first release dry-run.** Document the required GitHub Actions secrets;
   validate `make dist-mac`/`dist-win`/`dist-linux` locally (host-native) produce
   installable artifacts; do a pre-release `--publish never` dry run.
10. **License headers** on new scripts; keep `make test` green (add any script tests, e.g.
    a `build-versions` unit test, per Rest Hippo).

## Acceptance criteria
- `make dist-mac`/`dist-win`/`dist-linux` each produce installable artifacts for **both
  arm64 and x64** on their native host; macOS signs + notarizes + staples when creds are
  present and produces valid unsigned artifacts when they aren't.
- `make release VERSION=x.y.z` gates on tests, bumps versions, tags, and pushes atomically,
  triggering `release.yml`.
- `release.yml` builds the full OS × arch matrix on native runners, publishes them (plus the
  `latest*.yml` update feed) to a GitHub Release, and refreshes the Pages site.
- `ci.yml` runs lint + fmt-check + test + a packaging smoke build on every push/PR;
  `dco.yml` enforces sign-off; all actions are SHA-pinned with least-privilege tokens.
- The download site is live (Pages), auto-detects the visitor's OS/arch, links to the
  latest Release artifacts, and shows the current version from `versions.json`.
- In-app auto-update detects and offers a newer Release; `make test` green.

## Constraints
- electron-builder + Makefile + GitHub Actions only — no third-party CI/packaging service.
- Signed builds require native runners per platform; do not cross-build. Missing signing
  creds must degrade to unsigned, never fail the build (port the export-if-non-empty guard).
- SHA-pin every GitHub Action; keep workflow token permissions least-privilege.
- The website is static (no server); downloads point at GitHub Releases; secrets never
  appear in logs or the repo. MAS / Microsoft Store packaging is out of scope here.

## Verify
`make fmt && make lint && make test`. Locally run the host-native `make dist-*` and install
the produced artifact to confirm it launches. Push a test tag on a fork (or use
`workflow_dispatch`) and confirm `release.yml` builds the matrix and publishes a Release with
per-OS/arch installers + update YAML, then that `deploy-site.yml` updates the Pages site and
`downloads.js` offers the correct build for your platform. Confirm an in-app update check
sees the published Release.
