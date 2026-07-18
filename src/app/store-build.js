/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// store-build.js — single source of truth for "is this a sandboxed store build?".
//
// Jump Hippo ships ONE codebase to every channel: the direct GitHub-release
// builds (DMG/ZIP, NSIS/portable, AppImage/deb) AND the Mac App Store (MAS) and
// Microsoft Store (MSIX/appx) builds. The store builds run under tighter
// sandbox/policy rules, so store-incompatible features gate on the helpers
// below at runtime rather than branching the build.
//
// Electron sets these globals for us — we never set them ourselves:
//   • process.mas          true in a Mac App Store build (sandboxed MAS Electron).
//   • process.windowsStore true in an appx/MSIX build (full-trust Desktop Bridge).
//
// Gate scopes (see also STORE-PUBLISHING.md):
//   • isStoreBuild() — disable the self-updater (both stores deliver their own
//     updates; electron-builder strips the update feed from MAS/appx anyway)
//     and omit the "Check for Updates…" menu item (menu.js); disable
//     launch-at-login (the store login-item mechanisms aren't what Electron's
//     setLoginItemSettings drives).
//   • isMas()        — macOS-App-Sandbox-only restrictions: ssh-agent auth (the
//     SSH_AUTH_SOCK socket is outside the sandbox) and the "Import from SSH
//     config" default path (the sandbox can't read ~/.ssh from its own $HOME).
//
// The renderer is sandboxed and can't read process.mas itself, so `capabilities()`
// is handed to it over IPC (app:capabilities → window.jumphippo.build) and the UI
// gates on the map; main gates the same features directly on the predicates. Two
// former sandbox caveats are now fixed at the entitlement level — key-file paths
// survive a relaunch (Feature 190, app-scoped bookmarks) and ~/.ssh/known_hosts is
// read from the real home (home-relative-path temporary exception) — so the only
// remaining hard limit is the ssh-agent socket. See STORE-PUBLISHING.md.
"use strict";

/** True in a Mac App Store (sandboxed) build. */
function isMas() {
  return process.mas === true;
}

/** True in a Microsoft Store (appx/MSIX) build. */
function isAppx() {
  return process.windowsStore === true;
}

/** True in any store build (Mac App Store OR Microsoft Store). */
function isStoreBuild() {
  return isMas() || isAppx();
}

/**
 * Distribution flavor, surfaced in diagnostics so a bug report records which
 * channel produced the build.
 * @returns {"store" | "direct"}
 */
function distribution() {
  return isStoreBuild() ? "store" : "direct";
}

/**
 * The feature capabilities of THIS build, derived from the store flags. The
 * sandboxed renderer fetches this (app:capabilities → window.jumphippo.build) to
 * gate store-incompatible UI; main gates the same features directly on the
 * predicates. Each entry is `true` when the feature is available:
 *
 *   • sshAgentAuth        — false in a MAS build: the ssh-agent socket
 *     (SSH_AUTH_SOCK) lives outside the App Sandbox. Works on the full-trust
 *     Microsoft Store build.
 *   • launchAtLogin       — false in any store build: the sandbox/store login-item
 *     mechanisms aren't what Electron's setLoginItemSettings drives.
 *   • sshConfigDefaultPath — false in a MAS build: the sandbox can't read
 *     ~/.ssh/config from its own $HOME, so the import can't default to it (the
 *     user can still pick the file via the open panel).
 *   • selfUpdate          — false in any store build: the store delivers updates
 *     (already gated in updater.js / menu.js; included for a complete map).
 *
 * @returns {{ sshAgentAuth: boolean, launchAtLogin: boolean,
 *   sshConfigDefaultPath: boolean, selfUpdate: boolean }}
 */
function capabilities() {
  return {
    sshAgentAuth: !isMas(),
    launchAtLogin: !isStoreBuild(),
    sshConfigDefaultPath: !isMas(),
    selfUpdate: !isStoreBuild(),
  };
}

/**
 * Build metadata for the sandboxed renderer (over app:capabilities): the
 * distribution flavor plus the capability map, so the UI can gate features the
 * store build disables without reading process.mas itself.
 * @returns {{ distribution: "store"|"direct", capabilities: object }}
 */
function buildInfo() {
  return { distribution: distribution(), capabilities: capabilities() };
}

module.exports = {
  isMas,
  isAppx,
  isStoreBuild,
  distribution,
  capabilities,
  buildInfo,
};
