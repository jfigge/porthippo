# ─────────────────────────────────────────────────────────────────────────────
#  Port Hippo – On-demand SSH tunnel manager
#  Electron desktop app (Vanilla JS + Node.js)
# ─────────────────────────────────────────────────────────────────────────────

VERSION    ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
COMMIT     ?= $(shell git rev-parse --short=7 HEAD 2>/dev/null || echo "unknown")
BRANCH     ?= $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
BUILD_TIME ?= $(shell date -u '+%Y-%m-%dT%H:%M:%SZ')

# Workspace directories
WORKSPACE  ?= $(realpath $(dir $(realpath $(firstword $(MAKEFILE_LIST)))))
BUILD_DIR  ?= $(WORKSPACE)/build
DIST_DIR   ?= $(WORKSPACE)/dist
DATA_DIR   ?= $(WORKSPACE)/data
SRC_DIR    ?= $(WORKSPACE)/src
WEB_DIR    ?= $(WORKSPACE)/src/web
APP_DIR    ?= $(WORKSPACE)/src/app

SHELL := /bin/bash

# ── Shared dev environment ────────────────────────────────────────────────────
# One place to set the values every dev target sees. Copy dev.env.example →
# dev.env (git-ignored) and edit it; `-include` is after the ?= defaults so
# dev.env wins over them, while a one-off `make VAR=value` still wins over both.
DEV_ENV_VARS :=
-include $(WORKSPACE)/dev.env
export $(DEV_ENV_VARS)

# ── Release signing environment ───────────────────────────────────────────────
# Credentials for SIGNED installer builds (dist-mac / dist-win / sign-dmg). Copy
# release.env.example → release.env (git-ignored) and fill in the values; the
# `-include` + conditional `export` below hand them to electron-builder, which
# reads these names directly. All are optional — absent ⇒ electron-builder emits
# unsigned artifacts and skips notarization (see release.env.example). In CI the
# same names come from repository secrets, not this file.
#
# Export each var only when it is set AND non-empty; otherwise `unexport` it.
# This matters because:
#   * a blanket `export` of an undefined var hands it to electron-builder as an
#     EMPTY string, and an empty CSC_LINK / WIN_CSC_LINK is read as "a cert was
#     provided" → `… not a file` build failure; and
#   * CI sets `CSC_LINK: ${{ secrets.CSC_LINK }}` which is an empty (but present)
#     env var when the secret is unset — Make passes inherited env vars to
#     sub-processes automatically, so `unexport` is what actually strips it.
# Testing `$(value …)` (not `$(…)`) keeps secret contents out of Make expansion.
RELEASE_ENV_VARS := CSC_LINK CSC_KEY_PASSWORD CSC_IDENTITY_AUTO_DISCOVERY \
                    APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID \
                    APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER \
                    WIN_CSC_LINK WIN_CSC_KEY_PASSWORD
-include $(WORKSPACE)/release.env
$(foreach v,$(RELEASE_ENV_VARS),$(if $(strip $(value $(v))),$(eval export $(v)),$(eval unexport $(v))))

# Bare `make` builds an unsigned local dmg (macOS). Signed/release targets and
# the full multi-platform matrix arrive with Feature 70's dist-*/sign-* targets.
.DEFAULT_GOAL := dmg

# Neutralize signing for one electron-builder call: strip every release
# credential from its environment and disable keychain auto-discovery, so the
# output is unsigned regardless of release.env or inherited CI secrets. Used as
# `env $(UNSIGNED_ENV) npx electron-builder …`, paired per-recipe with
# `-c.mac.notarize=false` to also force notarization off.
UNSIGNED_ENV := $(foreach v,$(filter-out CSC_IDENTITY_AUTO_DISCOVERY,$(RELEASE_ENV_VARS)),-u $(v)) CSC_IDENTITY_AUTO_DISCOVERY=false

# Sign macOS builds with Developer ID + hardened-runtime entitlements. app-builder
# passes mac.entitlements straight to codesign without resolving it, and codesign
# runs from a cwd other than build/src — so an ABSOLUTE path is required (resolved
# here, where Make's cwd is the project root). The entitlements plist ships with
# Feature 70's src/packaging/. Only the signing targets use this; the UNSIGNED_ENV
# builds never invoke codesign with an identity.
MAC_ENTITLEMENTS := $(abspath $(BUILD_DIR)/src/packaging/entitlements.mac.plist)
MAC_SIGN_OVERRIDES := -c.mac.entitlements=$(MAC_ENTITLEMENTS) -c.mac.entitlementsInherit=$(MAC_ENTITLEMENTS)

# ─── Version / Info ───────────────────────────────────────────────────────────
version:
	@echo "Version: $(VERSION)"

info:
	@echo "Build Information:"
	@echo "  Version:    $(VERSION)"
	@echo "  Branch:     $(BRANCH)"
	@echo "  Commit:     $(COMMIT)"
	@echo "  Build Time: $(BUILD_TIME)"

# ─── Dependencies ─────────────────────────────────────────────────────────────
install:
	@echo "Installing Node.js dependencies..."
	@cd $(SRC_DIR) && npm install
	@echo "--------------------------------"

# ─── Development ──────────────────────────────────────────────────────────────
debug:
	@echo "Starting Electron in debug mode (hot-reload)..."
	@cd $(SRC_DIR) && npx electron app/main.js --hot-reload --user-data-dir=$(DATA_DIR)
	@echo "--------------------------------"

debug-inspect:
	@echo "Starting Electron in debug mode (hot-reload + DevTools)..."
	@cd $(SRC_DIR) && npx electron app/main.js --hot-reload --devtools --user-data-dir=$(DATA_DIR)
	@echo "--------------------------------"

# ─── Formatting ───────────────────────────────────────────────────────────────
fmt:
	@echo "Formatting JavaScript / CSS / HTML..."
	@cd $(SRC_DIR) && npx prettier --write \
		"web/**/*.{js,css,html}" \
		"app/**/*.js" > /dev/null
	@echo "--------------------------------"

fmt-check:
	@echo "Checking formatting (prettier --check)..."
	@cd $(SRC_DIR) && npx prettier --check \
		"web/**/*.{js,css,html}" \
		"app/**/*.js"
	@echo "--------------------------------"

# ─── Linting ──────────────────────────────────────────────────────────────────
lint:
	@echo "Linting JavaScript..."
	@cd $(SRC_DIR) && npx eslint \
		"web/scripts/**/*.js" \
		"app/**/*.js"
	@echo "--------------------------------"

# ─── License headers ──────────────────────────────────────────────────────────
# Stamp the Apache 2.0 header onto any first-party src/ JS+CSS or build script
# that is missing it (see CLAUDE.md → "License headers" for the scope).
license-headers:
	@echo "Stamping Apache 2.0 license headers..."
	@node $(WORKSPACE)/scripts/license-header.mjs
	@echo "--------------------------------"

# ─── Docs (Feature 80) ────────────────────────────────────────────────────────
# Bundle the Markdown renderer (marked + DOMPurify) → web/scripts/vendor/markdown.js.
# Re-run after bumping marked/DOMPurify; the generated bundle is committed.
vendor-markdown:
	@echo "Bundling Markdown (marked + DOMPurify) vendor file..."
	@cd $(SRC_DIR) && npm run vendor-markdown
	@echo "--------------------------------"

# Render the single-source user guide (src/web/docs/*.md) into website/docs/*.html
# (+ sitemap). The same Markdown feeds the in-app DocsViewer, so the two never
# drift; keep the PAGES lists in docs-viewer.js and build-docs.mjs in lockstep.
build-docs:
	@echo "Building hosted user guide (Markdown → website/docs/)..."
	@node $(WORKSPACE)/scripts/build-docs.mjs
	@echo "--------------------------------"

# ─── Testing ──────────────────────────────────────────────────────────────────
# Per-test timeout so a leaked handle / never-resolving promise fails the run
# loudly instead of hanging the suite (and CI) forever. Individual tests finish in
# well under a second; the ssh2 integration tests are the slowest and still < 1s.
TEST_TIMEOUT ?= 30000

test: test-license-headers test-js test-tunnel test-renderer

# Guard: every first-party src/ JS+CSS file and build script must carry the
# Apache 2.0 header. Fix any failure with `make license-headers`.
test-license-headers:
	@echo "Checking Apache 2.0 license headers (guard)..."
	@node $(WORKSPACE)/scripts/license-header.mjs --check
	@echo "--------------------------------"

# Unit tests: everything except the tunnel-engine integration suite (that runs
# under test-tunnel so it isn't executed twice).
test-js:
	@echo "Running JavaScript unit tests..."
	@cd $(SRC_DIR) && node --test --test-timeout=$(TEST_TIMEOUT) "app/tests/**/*.test.js" "app/store/**/*.test.js"
	@echo "--------------------------------"

# Integration tests for the SSH tunnel engine (in-process ssh2 server + echo dest).
test-tunnel:
	@echo "Running SSH tunnel engine integration tests..."
	@cd $(SRC_DIR) && node --test --test-timeout=$(TEST_TIMEOUT) "app/tunnel/**/*.test.js"
	@echo "--------------------------------"

# Renderer component tests (jsdom). Node auto-detects ESM in these .js files, so
# they import the real ES-module components and exercise them against a jsdom DOM.
test-renderer:
	@echo "Running renderer component tests (jsdom)..."
	@cd $(SRC_DIR) && node --test --test-timeout=$(TEST_TIMEOUT) "web/scripts/tests/**/*.test.js"
	@echo "--------------------------------"

# ─── Build ────────────────────────────────────────────────────────────────────
build: build-mac

# Fast, unsigned `--dir` packaging smoke-tests — one per platform. They exercise
# the full electron-builder pack (asar, file globs, native deps, icons) without
# producing installers, so CI can verify the app packages on macOS/Linux/Windows
# in ~1× runner minutes. Linux `--dir` needs no fpm (that's only for deb/AppImage)
# and Windows `--dir` needs no signtool, so both run credential-free. UNSIGNED_ENV
# strips every signing var (incl. WIN_CSC_*) so the output is unsigned regardless
# of inherited CI secrets.
build-mac: build-setup build-install
	@echo "Building Electron app for macOS (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --mac --dir --publish never -c.mac.notarize=false $(MAC_SIGN_OVERRIDES)
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

build-linux: build-setup build-install
	@echo "Building Electron app for Linux (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --linux --dir --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

build-win: build-setup build-install
	@echo "Building Electron app for Windows (dir, unsigned)..."
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --win --dir --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dmg: build-setup build-install
	@echo "Building macOS .dmg (unsigned, un-notarized)…"
	@cd $(BUILD_DIR)/src; env $(UNSIGNED_ENV) npx electron-builder --mac dmg --publish never -c.mac.notarize=false $(MAC_SIGN_OVERRIDES)
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

build-setup:
	@echo "Preparing build directory..."
	@rm -rf $(BUILD_DIR)/src || true
	@mkdir -p $(BUILD_DIR)/src
	@echo "COMMIT=$(COMMIT)" > $(BUILD_DIR)/src/REVISION_INFO.txt
	@echo "BRANCH=$(BRANCH)" >> $(BUILD_DIR)/src/REVISION_INFO.txt
	@echo "VERSION=$(VERSION)" >> $(BUILD_DIR)/src/REVISION_INFO.txt
	@rsync -a --exclude=node_modules $(SRC_DIR)/ $(BUILD_DIR)/src/

build-install:
	@echo "Installing Node.js dependencies (build dir)..."
	@cd $(BUILD_DIR)/src; npm install > /dev/null
	@echo "--------------------------------"

# ─── App icons ────────────────────────────────────────────────────────────────
# Regenerate the Windows .ico + Linux PNG icon set from the master
# icons/1024x1024.png. macOS-only (uses sips); outputs are committed and consumed
# at build time by the package.json `build` block. The macOS icon
# (src/web/porthippo-mac-icon.png) needs custom safe-area padding and is NOT
# regenerated here — it is maintained separately.
icons:
	@echo "Regenerating app icons from icons/1024x1024.png..."
	@node $(WORKSPACE)/scripts/make-icons.mjs
	@echo "--------------------------------"

# ─── Signed macOS builds (ready to ship) ──────────────────────────────────────
# Sign + notarize + staple. Read credentials from release.env (RELEASE_ENV_VARS);
# with none set electron-builder produces unsigned artifacts and staple-dmg skips.
sign-dmg: build-setup build-install
	@echo "Building macOS .dmg (signed + notarized — ready to ship)…"
	@cd $(BUILD_DIR)/src; npx electron-builder --mac dmg --publish never $(MAC_SIGN_OVERRIDES)
	@$(MAKE) staple-dmg
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

sign-all: build-setup build-install
	@echo "Building ALL platforms (macOS + Windows signed where creds present)…"
	@cd $(BUILD_DIR)/src; npx electron-builder --mac dmg --linux --win --publish never $(MAC_SIGN_OVERRIDES)
	@$(MAKE) staple-dmg
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

# ─── Distribution packages ────────────────────────────────────────────────────
# `dist` builds every platform, but a given host can only build its own (mac dmg
# needs macOS, etc.). CI runs dist-mac/linux/win on native runners; locally only
# the host-platform target succeeds. Each target builds BOTH arm64 and x64 (the
# arches declared per target in src/package.json's `build` block).
#
# Signing & notarization: dist-mac signs + notarizes when the RELEASE_ENV_VARS
# credentials are present (release.env locally, secrets in CI); dist-win signs
# with WIN_CSC_*. With none set the artifacts are simply unsigned — no failure.
dist: dist-mac dist-linux dist-win

dist-mac: build-setup build-install
	@echo "Building macOS distribution (dmg/zip, arm64 + x64)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --mac --publish never $(MAC_SIGN_OVERRIDES)
	@$(MAKE) staple-dmg
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dist-linux: build-setup build-install
	@echo "Building Linux distribution (AppImage/deb, arm64 + x64)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --linux --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

dist-win: build-setup build-install
	@echo "Building Windows distribution (nsis/portable, arm64 + x64)..."
	@cd $(BUILD_DIR)/src; npx electron-builder --win --publish never
	@echo "  → $(BUILD_DIR)/src/dist/"
	@echo "--------------------------------"

# ─── Notarize & staple the DMGs ───────────────────────────────────────────────
# electron-builder notarizes/staples the .app but leaves the .dmg wrapper unsigned
# and un-notarized — so a freshly-built .dmg is "not signed at all", `spctl` can't
# assess it, and `stapler` can't staple it (Apple has no record of the dmg's hash
# → error 65). This SIGNS each .dmg with the Developer ID Application identity,
# submits it to notarytool, and staples the returned ticket — so the disk image is
# itself signed + notarized and passes `spctl -a -t open` offline. Order matters:
# sign BEFORE notarizing (signing changes the dmg's hash, invalidating any ticket).
# Invoked by dist-mac / sign-dmg; also runnable on its own to fix DMGs already in
# dist/ without a full rebuild.
#
# Notarization creds mirror electron-builder: App Store Connect API key
# (APPLE_API_*) if present, else Apple ID + app-specific password (APPLE_ID /
# APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID); with neither set it skips cleanly
# so unsigned / credential-less builds still pass. The signing identity comes from
# $$CSC_NAME if set, else the first "Developer ID Application" identity in the
# keychain; if none is found the dmg is notarized+stapled UNSIGNED rather than
# failing the build.
staple-dmg:
	@set -e; \
	DIST="$(BUILD_DIR)/src/dist"; \
	dmgs=$$(ls "$$DIST"/*.dmg 2>/dev/null || true); \
	if [ -z "$$dmgs" ]; then echo "No .dmg in $$DIST — nothing to staple."; exit 0; fi; \
	if [ -n "$$APPLE_API_KEY" ] && [ -n "$$APPLE_API_KEY_ID" ] && [ -n "$$APPLE_API_ISSUER" ]; then \
		auth="--key $$APPLE_API_KEY --key-id $$APPLE_API_KEY_ID --issuer $$APPLE_API_ISSUER"; \
		echo "Notarizing DMG(s) via App Store Connect API key…"; \
	elif [ -n "$$APPLE_ID" ] && [ -n "$$APPLE_APP_SPECIFIC_PASSWORD" ] && [ -n "$$APPLE_TEAM_ID" ]; then \
		auth="--apple-id $$APPLE_ID --password $$APPLE_APP_SPECIFIC_PASSWORD --team-id $$APPLE_TEAM_ID"; \
		echo "Notarizing DMG(s) via Apple ID…"; \
	else \
		echo "No Apple notarization credentials set — skipping DMG notarization (unsigned build)."; \
		exit 0; \
	fi; \
	if [ -n "$$CSC_NAME" ]; then \
		identity="$$CSC_NAME"; \
	else \
		identity=$$(security find-identity -p codesigning -v 2>/dev/null | grep "Developer ID Application" | head -1 | awk '{print $$2}'); \
	fi; \
	for d in "$$DIST"/*.dmg; do \
		[ -e "$$d" ] || continue; \
		if [ -n "$$identity" ]; then \
			echo "  → codesign (Developer ID) $$d"; \
			codesign --force --timestamp --sign "$$identity" "$$d"; \
		else \
			echo "  ! no Developer ID identity found — notarizing $$d UNSIGNED"; \
		fi; \
		echo "  → notarytool submit $$d"; \
		xcrun notarytool submit "$$d" $$auth --wait; \
		echo "  → stapler staple $$d"; \
		xcrun stapler staple "$$d"; \
	done; \
	echo "DMG sign + notarize + staple complete."

# ─── Release ──────────────────────────────────────────────────────────────────
# Cut a release (Model A — "shipped pointer"):
#   validate -> preflight (on main, clean, in sync with origin) -> gate on tests
#   -> bump src/package.json (+ website version placeholders) on main -> fast-
#   forward `release` to main -> tag -> atomic push of main + release + tag (the
#   tag push triggers the build). `release` stays a strict fast-forward of `main`,
#   so history is linear and the branch always points at what was last shipped.
# Usage:  make release VERSION=1.2.3
MAIN_BRANCH    ?= main
RELEASE_BRANCH ?= release

release:
	@set -e; \
	NEW="$(VERSION)"; \
	if ! [[ "$$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$$ ]]; then \
		echo "Error: version must be in x.y.z format (got '$$NEW')."; \
		echo "Usage: make release VERSION=1.2.3"; exit 1; \
	fi; \
	ORIG=$$(git rev-parse --abbrev-ref HEAD); \
	trap 'git checkout "$$ORIG" --quiet 2>/dev/null || true' EXIT; \
	if [ "$$ORIG" != "$(MAIN_BRANCH)" ]; then \
		echo "Error: release must be run from '$(MAIN_BRANCH)' (currently on '$$ORIG')."; exit 1; \
	fi; \
	if ! git diff-index --quiet HEAD --; then \
		echo "Error: working tree has uncommitted changes; commit or stash first."; exit 1; \
	fi; \
	CURRENT=$$(cd $(SRC_DIR) && node -p "require('./package.json').version"); \
	if [ "$$NEW" = "$$CURRENT" ]; then \
		echo "Error: new version equals the current version ($$CURRENT)."; exit 1; \
	fi; \
	echo "Fetching origin..."; \
	git fetch --quiet --tags origin; \
	if git rev-parse -q --verify "refs/tags/v$$NEW" >/dev/null; then \
		echo "Error: tag v$$NEW already exists."; exit 1; \
	fi; \
	if ! git merge-base --is-ancestor origin/$(MAIN_BRANCH) $(MAIN_BRANCH); then \
		echo "Error: local '$(MAIN_BRANCH)' is behind/diverged from origin; pull or rebase first."; exit 1; \
	fi; \
	echo ""; \
	echo "  Current version: $$CURRENT"; \
	echo "  New version:     $$NEW"; \
	echo "  Flow: bump on $(MAIN_BRANCH) -> ff '$(RELEASE_BRANCH)' -> tag v$$NEW -> push (triggers build)"; \
	echo ""; \
	read -p "Run tests and cut release v$$NEW? [y/N] " ans; \
	if [[ "$$ans" != "y" && "$$ans" != "Y" ]]; then echo "Aborted."; exit 1; fi; \
	echo "Running test suite..."; \
	if ! $(MAKE) test; then echo "Tests failed; aborting release (no changes made)."; exit 1; fi; \
	echo "Bumping version on $(MAIN_BRANCH)..."; \
	(cd $(SRC_DIR) && npm version "$$NEW" --no-git-tag-version >/dev/null); \
	git add src/package.json src/package-lock.json; \
	if [ -f website/index.html ]; then \
		sed -i.bak -E \
			-e "s|(id=\"hero-version\">)v[0-9]+\.[0-9]+\.[0-9]+|\1v$$NEW|" \
			-e "s|(id=\"dl-version\">)[0-9]+\.[0-9]+\.[0-9]+|\1$$NEW|" \
			-e "s|(id=\"footer-version\">)v[0-9]+\.[0-9]+\.[0-9]+|\1v$$NEW|" \
			website/index.html && rm -f website/index.html.bak; \
		git add website/index.html; \
	fi; \
	git commit -m "Release v$$NEW" >/dev/null; \
	echo "Fast-forwarding $(RELEASE_BRANCH) to $(MAIN_BRANCH)..."; \
	if git show-ref --verify --quiet refs/remotes/origin/$(RELEASE_BRANCH); then \
		git checkout -B $(RELEASE_BRANCH) origin/$(RELEASE_BRANCH) --quiet; \
	elif git show-ref --verify --quiet refs/heads/$(RELEASE_BRANCH); then \
		git checkout $(RELEASE_BRANCH) --quiet; \
	else \
		git checkout -b $(RELEASE_BRANCH) --quiet; \
	fi; \
	git merge --ff-only $(MAIN_BRANCH) --quiet; \
	git tag -a "v$$NEW" -m "Release v$$NEW"; \
	echo "Pushing $(MAIN_BRANCH) + $(RELEASE_BRANCH) + tag v$$NEW (atomic)..."; \
	if ! git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) "v$$NEW"; then \
		echo "Push failed. Local commit/tag were created but nothing was pushed."; \
		echo "Retry with: git push --atomic origin $(MAIN_BRANCH) $(RELEASE_BRANCH) v$$NEW"; \
		exit 1; \
	fi; \
	echo "Released v$$NEW — the Release workflow will build and publish the installers."; \
	SLUG=$$(git remote get-url origin 2>/dev/null | sed -E 's#^.*github\.com[:/]##; s#\.git$$##'); \
	if [ -n "$$SLUG" ]; then \
		echo "  Release: https://github.com/$$SLUG/releases/tag/v$$NEW"; \
	fi

# ─── Synchronize Secrets ──────────────────────────────────────────────────────
# Push the macOS / Windows signing credentials from release.env up to this repo's
# GitHub Actions secrets (consumed by the Release workflow). The value is read via
# $(…) command substitution — which strips the trailing newline — then re-emitted
# with `printf %s` and piped to `gh secret set` (never echoed). A trailing newline
# would be stored verbatim and corrupt the secret. Empty/missing keys are skipped
# so we never push a blank CSC_LINK (the empty-cert footgun the export logic guards).
sync-mac:
	@echo "Pushing mac secrets to GitHub repository secrets (for GitHub Actions)…"
	@for k in CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID; do \
		v=$$(grep "^$$k=" $(WORKSPACE)/release.env | head -1 | cut -d= -f2-); \
		if [ -z "$$v" ]; then echo "  ! $$k missing/empty in release.env — skipping"; continue; fi; \
		printf '%s' "$$v" | gh secret set "$$k" && echo "  ✓ $$k"; \
	done
	@echo "--------------------------------"

sync-win:
	@echo "Pushing windows secrets to GitHub repository secrets (for GitHub Actions)…"
	@for k in WIN_CSC_LINK WIN_CSC_KEY_PASSWORD; do \
		v=$$(grep "^$$k=" $(WORKSPACE)/release.env | head -1 | cut -d= -f2-); \
		if [ -z "$$v" ]; then echo "  ! $$k missing/empty in release.env — skipping"; continue; fi; \
		printf '%s' "$$v" | gh secret set "$$k" && echo "  ✓ $$k"; \
	done
	@echo "--------------------------------"

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf $(BUILD_DIR) $(DIST_DIR)
	@echo "--------------------------------"

# ─── Integration-test sandbox (Docker) ────────────────────────────────────────
# Two containers modelling Port Hippo's jump-host scenario: a host-reachable jump
# host and a destination reachable ONLY through it, each running an SSH server
# (password + key auth) and a loopback-only echo service. See docker/README.md.
SANDBOX_DIR ?= $(WORKSPACE)/docker
COMPOSE     ?= docker compose
SANDBOX_KEY  = $(SANDBOX_DIR)/keys/id_porthippo

# Generate the throwaway SSH keypair the containers authorise (idempotent).
sandbox-keys:
	@mkdir -p $(SANDBOX_DIR)/keys
	@if [ ! -f $(SANDBOX_KEY) ]; then \
	  echo "Generating sandbox SSH keypair ($(SANDBOX_KEY))..."; \
	  ssh-keygen -t ed25519 -N '' -C porthippo-sandbox -f $(SANDBOX_KEY) >/dev/null; \
	  cp $(SANDBOX_KEY).pub $(SANDBOX_DIR)/keys/authorized_keys; \
	fi

# Build the image and create the containers + networks (without starting them).
sandbox-create: sandbox-keys
	@echo "Building sandbox image + creating containers..."
	@cd $(SANDBOX_DIR) && $(COMPOSE) build
	@cd $(SANDBOX_DIR) && $(COMPOSE) up --no-start
	@echo "Created. Run 'make sandbox-start' to start + print access details."

# Start the containers (creating anything missing) and print access details.
sandbox-start: sandbox-keys
	@cd $(SANDBOX_DIR) && $(COMPOSE) up -d
	@bash $(SANDBOX_DIR)/access.sh

# Stop the containers but keep them (fast restart, state preserved).
sandbox-stop:
	@cd $(SANDBOX_DIR) && $(COMPOSE) stop

# Remove the containers + networks (keeps the built image and the keys).
sandbox-destroy:
	@cd $(SANDBOX_DIR) && $(COMPOSE) down --remove-orphans

# Seed Port Hippo's store (the `make debug` data dir) with definitions matching the
# sandbox: two credentials (key + password), the jump host, and both tunnels.
# Idempotent — re-running only adds what's missing.
sandbox-seed:
	@node $(SANDBOX_DIR)/seed-porthippo.js $(DATA_DIR)

# Prove the topology end-to-end: local (direct + via jump), dynamic reachability
# (jump → sealed dest), and reverse forwarding (jump → a host-side echo).
sandbox-verify:
	@bash $(SANDBOX_DIR)/verify.sh

# Exercise Port Hippo's OWN tunnel engine over the sandbox — one real round-trip per
# forwarding type (local direct, local via jump, dynamic/SOCKS, reverse). Where
# sandbox-verify uses raw ssh to prove the topology, this drives the actual
# listener → ssh-chain → relay/socks5 code. Requires the sandbox running
# ('make sandbox-start'); exits non-zero on any failure, so it is CI-friendly.
sandbox-e2e:
	@node $(SANDBOX_DIR)/e2e.js

# Run the host-side echo the REMOTE (reverse, Feature 110) tunnel forwards back to.
# Leave it running in its own terminal, then arm "Sandbox — reverse forward" in the
# debug app and trigger it from the jump container (see 'make sandbox-access').
sandbox-host-echo:
	@set -a; . $(SANDBOX_DIR)/.env; set +a; \
	  node $(SANDBOX_DIR)/host-echo.js "$${HOST_ECHO_PORT:-9091}"

# Re-print the access details.
sandbox-access:
	@bash $(SANDBOX_DIR)/access.sh

sandbox-status:
	@cd $(SANDBOX_DIR) && $(COMPOSE) ps

sandbox-logs:
	@cd $(SANDBOX_DIR) && $(COMPOSE) logs -f

# ─── Help ─────────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  Port Hippo — On-demand SSH tunnel manager"
	@echo ""
	@echo "  Targets:"
	@echo "    install       Install Node.js dependencies"
	@echo "    debug         Run Electron with hot-reload (primary dev workflow)"
	@echo "    debug-inspect Run Electron with hot-reload + DevTools open"
	@echo "    fmt           Format JS/CSS/HTML (prettier)"
	@echo "    fmt-check     Check formatting without writing (prettier --check)"
	@echo "    lint          Lint JS (eslint)"
	@echo "    test          Run license-header guard + JS unit tests"
	@echo "    license-headers  Stamp the Apache 2.0 header on any file missing it"
	@echo "    vendor-markdown  Bundle marked+DOMPurify → web/scripts/vendor/markdown.js"
	@echo "    build-docs    Render the user guide (Markdown) → website/docs/"
	@echo "    build         Build Electron app for macOS (dir only, unsigned)"
	@echo "    dmg           Build unsigned macOS .dmg (default 'make')"
	@echo "    icons         Regenerate app icons from icons/1024x1024.png"
	@echo "    clean         Remove build and dist directories"
	@echo "    version       Print version string"
	@echo "    info          Print full build information"
	@echo ""
	@echo "  Release / distribution (signed when creds present in release.env):"
	@echo "    sign-dmg      Signed + notarized macOS .dmg (ready to ship)"
	@echo "    sign-all      Signed installers for ALL platforms"
	@echo "    dist          Build installers for all platforms (arm64 + x64)"
	@echo "    dist-mac      Build macOS installers (dmg/zip, arm64 + x64)"
	@echo "    dist-linux    Build Linux installers (AppImage/deb, arm64 + x64)"
	@echo "    dist-win      Build Windows installers (nsis/portable, arm64 + x64)"
	@echo "    staple-dmg    Sign + notarize + staple the dmg(s) in dist/"
	@echo "    release       Bump version, tag, push to trigger a release (VERSION=x.y.z)"
	@echo "    sync-mac      Push macOS signing creds from release.env → GitHub secrets"
	@echo "    sync-win      Push Windows signing creds from release.env → GitHub secrets"
	@echo ""
	@echo "  Integration-test sandbox (Docker jump-host + destination):"
	@echo "    sandbox-create  Build image + create containers/networks (not started)"
	@echo "    sandbox-start   Start the containers and print access details"
	@echo "    sandbox-stop    Stop the containers (keep state)"
	@echo "    sandbox-destroy Remove containers + networks (keeps image + keys)"
	@echo "    sandbox-seed    Seed Port Hippo with the sandbox tunnels/credentials"
	@echo "    sandbox-verify  Prove local + dynamic + reverse forwarding all work (raw ssh)"
	@echo "    sandbox-e2e     Exercise Port Hippo's engine over the sandbox (all 4 tunnel types)"
	@echo "    sandbox-host-echo  Run the host-side echo the reverse tunnel targets"
	@echo "    sandbox-access  Re-print the access details"
	@echo "    sandbox-status  docker compose ps  ·  sandbox-logs  Follow logs"

.PHONY: version info install debug debug-inspect fmt fmt-check lint license-headers \
        vendor-markdown build-docs test \
        test-license-headers test-js test-tunnel build build-mac build-linux build-win dmg \
        build-setup build-install icons sign-dmg sign-all dist dist-mac dist-linux dist-win \
        staple-dmg release sync-mac sync-win clean help \
        sandbox-keys sandbox-create sandbox-start sandbox-stop sandbox-destroy \
        sandbox-seed sandbox-verify sandbox-e2e sandbox-host-echo sandbox-access sandbox-status sandbox-logs
