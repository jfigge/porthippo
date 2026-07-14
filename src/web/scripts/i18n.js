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

// i18n.js — the renderer's localization seam (ported from Rest Hippo, adapted).
//
// `t(key, params?)` looks a display string up by its `area.component.label` key;
// `formatNumber` / `formatDate` are locale-aware `Intl` wrappers. English is the
// SHIPPED, complete catalog and is EMBEDDED here as `EN`, so `t()` resolves
// synchronously the moment a module imports it — no `await` before first paint,
// and the jsdom component tests see real English without an init step.
//
// `init()` (awaited once in app.js) asks the main process for the active locale's
// catalog over IPC and layers it on top via `applyCatalog`. Shipping additional
// locales is therefore purely additive: drop a `src/web/locales/<lang>.json`
// beside `en.json` and translate — no component changes, and any key a locale
// omits falls back to English, then to the key itself (so a gap is visible, never
// blank). `EN` is kept byte-identical to `locales/en.json` by a completeness test.

// The embedded English catalog. FLAT `area.component.label` keys; `{name}`
// placeholders interpolate from `params`. Object-valued entries are CLDR plural
// forms selected by a numeric `params.count` (none today — the mechanism is
// here so a translated plural "just works").
export const EN = {
  // ── Common ──────────────────────────────────────────────────────────────
  "common.confirm": "Confirm",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.save": "Save",
  "common.edit": "Edit",
  "common.close": "Close",
  "common.trust": "Trust",
  "common.reject": "Reject",
  "common.dismiss": "Dismiss",

  // ── Definition view — master list ───────────────────────────────────────
  "def.list.title": "Tunnels",
  "def.list.add": "New tunnel",
  "def.list.empty": "No tunnels yet.",
  "def.list.emptyHint": "Create one to get started.",
  "def.list.arm": "Arm",
  "def.list.disarm": "Disarm",
  "def.list.edit": "Edit tunnel",
  "def.list.duplicate": "Duplicate tunnel",
  "def.list.delete": "Delete tunnel",
  "def.list.summary": "localhost:{localPort} → {host}:{port}",
  "def.unnamed": "Untitled tunnel",

  "def.delete.title": "Delete tunnel?",
  "def.delete.message": "Delete “{name}”? This can’t be undone.",

  // ── Tunnel editor (modal) ───────────────────────────────────────────────
  "editor.newTitle": "New tunnel",
  "editor.editTitle": "Edit tunnel",
  "editor.name": "Name",
  "editor.localPort": "Local port",
  "editor.localPort.privileged":
    "Ports below 1024 usually need elevated privileges.",
  "editor.localPort.conflict": "Port {port} is already used by “{name}”.",
  "editor.bindHost": "Bind address",
  "editor.bindHost.hint": "127.0.0.1 keeps the tunnel private to this machine.",
  "editor.bindHost.warning":
    "This binds beyond loopback — reachable by other machines on your network.",
  "editor.destination": "Destination",
  "editor.destination.host": "Host",
  "editor.destination.port": "Port",
  "editor.credential": "Credential",
  "editor.advanced": "Advanced",
  "editor.sshHost": "SSH server",
  "editor.sshHost.placeholder": "Same as destination",
  "editor.sshHost.hint":
    "Only needed when a bastion forwards on to a different internal host.",
  "editor.sshPort": "SSH port",
  "editor.jumps": "Jump hosts",
  "editor.linger": "Idle linger (ms)",
  "editor.linger.hint":
    "How long to hold the SSH connection open after the last local client disconnects.",
  "editor.keepAlive": "Keep SSH connected while armed",
  "editor.enabled": "Arm on startup",
  "editor.autoReconnect": "Reconnect automatically if the connection drops",
  "editor.duplicateSuffix": " (copy)",
  "editor.saveError": "Couldn’t save: {message}",

  // ── Credential editor / picker ──────────────────────────────────────────
  "cred.newTitle": "New credential",
  "cred.editTitle": "Edit credential",
  "cred.label": "Name",
  "cred.label.placeholder": "e.g. Prod deploy key",
  "cred.user": "SSH user",
  "cred.user.placeholder": "username",
  "cred.new": "New…",
  "cred.choose": "Choose a credential…",

  // ── Jump-host editor / picker ───────────────────────────────────────────
  "jump.newTitle": "New jump host",
  "jump.editTitle": "Edit jump host",
  "jump.label": "Name",
  "jump.label.placeholder": "e.g. Corp bastion",
  "jump.host.placeholder": "hostname or IP",
  "jumps.empty": "No jump hosts — a direct connection.",
  "jumps.new": "New…",
  "jumps.choose": "Add a jump host…",
  "jumps.missing": "(deleted jump host)",
  "jumps.remove": "Remove jump host",
  "jumps.moveUp": "Move up",
  "jumps.moveDown": "Move down",

  // ── Hop / auth field labels (shared by the editors) ─────────────────────
  "hop.host": "Host",
  "hop.port": "Port",
  "auth.type": "Type",
  "auth.type.agent": "SSH agent",
  "auth.type.key": "Private key",
  "auth.type.password": "Password",
  "auth.keyPath": "Key file",
  "auth.keyPath.placeholder": "Path to private key",
  "auth.browse": "Browse…",
  "auth.passphrase": "Passphrase",
  "auth.password": "Password",
  "auth.secretSet": "•••• set",
  "auth.secretKeep": "Stored — leave blank to keep",
  "auth.agentHint": "Uses your running SSH agent — no key file or password.",

  // ── Monitoring view ─────────────────────────────────────────────────────
  "mon.title": "Live tunnels",
  "mon.filter.all": "All",
  "mon.filter.active": "Active",
  "mon.filter.all.title": "Show every defined tunnel",
  "mon.filter.active.title": "Show only connected or paused tunnels",
  "mon.empty": "No tunnels defined yet — add one in the Definition view.",
  "mon.empty.active": "No active tunnels.",
  "mon.rateUp": "▲ {rate}",
  "mon.rateDown": "▼ {rate}",
  "mon.rateUp.title": "Upload rate (client → destination)",
  "mon.rateDown.title": "Download rate (destination → client)",
  "mon.total": "total {total}",
  "mon.total.title": "Total transferred this session",
  "mon.conns": "conns {n}",
  "mon.conns.title": "Active connections",
  "mon.open": "up {duration}",
  "mon.open.title": "How long the SSH session has been open",
  "mon.open.none": "—",
  "mon.last": "last {when}",
  "mon.last.title": "Last byte transferred",
  "mon.pause": "Pause",
  "mon.resume": "Resume",
  "mon.arm": "Arm",
  "mon.disarm": "Disarm",
  "mon.edit": "Edit",
  "mon.edit.title": "Edit this tunnel in the Definition view",

  // ── State badges ────────────────────────────────────────────────────────
  "state.disarmed": "Disarmed",
  "state.listening": "Listening",
  "state.connecting": "Connecting",
  "state.connected": "Connected",
  "state.paused": "Paused",
  "state.error": "Error",

  // ── Tunnels sidebar (master list) ───────────────────────────────────────
  "tunnels.title": "Tunnels",
  "tunnels.add": "Add tunnel",
  "tunnels.edit": "Edit tunnel",
  "tunnels.delete": "Delete tunnel",
  "tunnels.empty": "No tunnels yet.",
  "tunnels.emptyHint": "Add one to get started.",
  "tunnels.selectHint": "Select a tunnel to see its live details.",

  // ── Tunnel detail (breadcrumb + controls) ───────────────────────────────
  "detail.arm": "Arm tunnel",
  "detail.disarm": "Disarm tunnel",
  "detail.pause": "Pause traffic",
  "detail.resume": "Resume traffic",
  "detail.reorderHint": "Drag to rearrange",
  "detail.route.local": "Local",
  "detail.route.target": "Target",
  "detail.cards": "Data Fields",
  "detail.cards.title": "Choose which data fields to show",
  "detail.cards.menuTitle": "Data fields",
  "detail.cards.empty": "No data fields shown — use “Data Fields” to add some.",

  // ── Detail cards ────────────────────────────────────────────────────────
  "card.download": "Download",
  "card.upload": "Upload",
  "card.connections": "Connections",
  "card.connectionCount": "Total connections",
  "card.transferred": "Transferred",
  "card.sent": "Sent",
  "card.received": "Received",
  "card.openFor": "Open for",
  "card.idle": "Idle",
  "card.firstConnection": "First connection",
  "card.lastConnection": "Last connection",
  "card.lastDisconnect": "Last disconnect",
  "card.errors": "Errors",
  "card.state": "State",
  "card.none": "—",

  // ── View mode + all-tunnels list (table) ────────────────────────────────
  "view.mode.label": "View",
  "view.mode.cards": "Cards",
  "view.mode.list": "List",
  "table.tunnel": "Tunnel",
  "table.sortHint": "Sort by {name}",

  // ── Host-key trust prompt (TOFU) ────────────────────────────────────────
  "hostkey.unknown.title": "Unknown SSH host key",
  "hostkey.unknown.message":
    "The host {host}:{port} presented a key we haven’t seen before.",
  "hostkey.unknown.question": "Trust this host and continue connecting?",
  "hostkey.hop": "Hop: {hop}",
  "hostkey.fingerprint": "Fingerprint",
  "hostkey.changed.title": "⚠ SSH host key changed",
  "hostkey.changed.message":
    "The key for {host}:{port} has CHANGED since you last connected. This can indicate a machine-in-the-middle attack, so the connection was refused.",

  // ── Auto-update (Feature 70) ────────────────────────────────────────────
  "update.title": "Software update",
  "update.available": "Update {version} found — downloading in the background…",
  "update.upToDate": "You’re on the latest version.",
  "update.devBuild": "This is a development build; updates are disabled.",
  "update.error": "Update check failed: {message}",
  "update.ready.title": "Update ready",
  "update.ready.message":
    "Version {version} has been downloaded. Restart now to install it?",
  "update.ready.restart": "Restart & install",
  "update.ready.later": "Later",

  // ── App shell / header (Feature 60) ─────────────────────────────────────
  "header.settings": "Settings",
  "header.about": "About Port Hippo",

  // ── About dialog (Feature 60) ───────────────────────────────────────────
  "about.name": "Port Hippo",
  "about.subtitle": "SSH Tunnel Manager",
  "about.description": "On-demand SSH tunnels for your desktop.",
  "about.credit": "Created by Jason, coded by Claude",
  "about.versionInfo": "Version information",
  "about.version": "Version",
  "about.platform": "Platform",
  "about.electron": "Electron",
  "about.devBuild": "dev build",

  // ── Settings panel (Feature 60) ─────────────────────────────────────────
  "settings.title": "Settings",
  "settings.nav.appearance": "Appearance",
  "settings.nav.defaults": "Defaults",
  "settings.nav.behaviour": "Behaviour",
  "settings.nav.security": "Security",

  "settings.appearance.theme": "Theme",
  "settings.appearance.theme.system": "System",
  "settings.appearance.theme.light": "Light",
  "settings.appearance.theme.dark": "Dark",
  "settings.appearance.language": "Language",
  "settings.appearance.language.system": "System default",

  "settings.defaults.linger": "Default idle linger (ms)",
  "settings.defaults.linger.hint":
    "Seeded into new tunnels: how long to hold SSH open after the last client disconnects.",
  "settings.defaults.bindHost": "Default bind address",
  "settings.defaults.bindHost.hint":
    "Seeded into new tunnels. 127.0.0.1 keeps them private to this machine.",
  "settings.defaults.keepAlive": "Keep SSH connected while armed",
  "settings.defaults.keepAlive.hint":
    "The keep-alive default for new tunnels (they can override it).",

  "settings.behaviour.launchAtLogin": "Launch Port Hippo at login",
  "settings.behaviour.startMinimized": "Start minimized to the tray",
  "settings.behaviour.startMinimized.hint":
    "Only applies when launched at login.",
  "settings.behaviour.armOnLaunch": "Arm enabled tunnels on launch",
  "settings.behaviour.confirmOnQuit": "Confirm before quitting",
  "settings.behaviour.confirmOnQuit.hint":
    "Quitting disarms every tunnel and closes its SSH connections.",

  // ── Settings → Security (selectable secret storage, Feature 90) ─────────
  "settings.security.heading": "Secret storage",
  "settings.security.help":
    "Choose how Port Hippo encrypts SSH passwords and key passphrases on this device. Switching re-encrypts every stored secret.",
  "settings.security.modeAria": "Secret storage mode",
  "settings.security.mode.appKey": "This device (no prompt)",
  "settings.security.mode.appKeyDesc":
    "Encrypt with a key kept on this device. No system prompts — but anyone who can read this computer’s files could read your secrets.",
  "settings.security.mode.osKeychain": "OS keychain",
  "settings.security.mode.osKeychainDesc":
    "Encrypt with your operating system’s keychain. Strongest protection, but the OS may prompt for access.",
  "settings.security.mode.masterPassword": "Master password",
  "settings.security.mode.masterPasswordDesc":
    "Encrypt with a password you choose. Secrets stay locked until you unlock them each session. If you forget it, they can’t be recovered.",
  "settings.security.lockedNote":
    "Secrets are locked. Enter your master password to unlock them for this session.",
  "settings.security.password": "Password",
  "settings.security.confirmPassword": "Confirm password",
  "settings.security.reveal": "Show password",
  "settings.security.hide": "Hide password",
  "settings.security.setPasswordWarn":
    "If you forget this password, your stored secrets can’t be recovered.",
  "settings.security.setPasswordSubmit": "Set password & encrypt",
  "settings.security.unlock": "Unlock",
  "settings.security.unlocking": "Unlocking…",
  "settings.security.switching": "Re-encrypting secrets…",
  "settings.security.switchMessage":
    "This re-encrypts every stored secret with the new method. Continue?",
  "settings.security.switchConfirm": "Switch",
  "settings.security.error.passwordRequired": "Enter a password.",
  "settings.security.error.passwordMismatch": "The passwords don’t match.",
  "settings.security.error.badPassword": "Incorrect password.",
  "settings.security.error.migrationFailed":
    "Some secrets couldn’t be converted, so the storage method was left unchanged.",
  "settings.security.error.keychainUnavailable":
    "The OS keychain isn’t available on this system.",
  "settings.security.error.lockedSwitch":
    "Unlock your secrets first, then switch storage method.",
  "settings.security.error.generic": "Something went wrong. Please try again.",

  // ── Native menu (rendered by the MAIN process via its own i18n) ─────────
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.window": "Window",
  "menu.help": "Help",
  "menu.newTunnel": "New Tunnel",
  "menu.armAll": "Arm All Tunnels",
  "menu.disarmAll": "Disarm All Tunnels",
  "menu.settings": "Settings…",
  "menu.view": "View",
  "menu.viewDefinition": "Definition",
  "menu.viewMonitoring": "Monitoring",
  "menu.copyDiagnostics": "Copy Diagnostics",
  "menu.showLogs": "Show Logs Folder",
  "menu.about": "About Port Hippo",
  "menu.hide": "Hide Port Hippo",
  "menu.quit": "Quit Port Hippo",
  "menu.checkUpdates": "Check for Updates…",

  // ── Tray (MAIN process) ─────────────────────────────────────────────────
  "tray.show": "Show Port Hippo",
  "tray.tunnels": "Tunnels",
  "tray.armAll": "Arm All",
  "tray.disarmAll": "Disarm All",
  "tray.settings": "Settings…",
  "tray.copyDiagnostics": "Copy Diagnostics",
  "tray.quit": "Quit Port Hippo",
  "tray.tooltip": "Port Hippo — {active} of {total} active",
  "tray.tooltip.none": "Port Hippo — no tunnels",

  // ── Shell notifications / dialogs (MAIN process) ────────────────────────
  "shell.hide.title": "Port Hippo is still running",
  "shell.hide.body":
    "Tunnels stay active in the background. Use the tray icon to show the window or quit.",
  "shell.quit.title": "Quit Port Hippo?",
  "shell.quit.message":
    "Quitting disarms every tunnel and closes its SSH connections.",
  "shell.quit.confirm": "Quit",
  "shell.diagnostics.copied": "Diagnostics copied to the clipboard.",
};

// ── Module state ─────────────────────────────────────────────────────────────
// Default to the embedded English so `t()` works before `init()` resolves.
let _active = "en";
let _lang = "en";
let _messages = EN;
let _fallback = EN;
let _pluralRules = null;

/** Locale options for the settings picker. `system` follows the OS locale. */
export const LOCALE_OPTIONS = [
  { value: "system", labelKey: "settings.appearance.language.system" },
  { value: "en", label: "English" },
];

function lookup(catalog, key) {
  if (!catalog) return undefined;
  if (Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
  // Dotted-path walk for nested catalogs (a future locale may nest its groups).
  let node = catalog;
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in node) node = node[part];
    else return undefined;
  }
  return node;
}

function pluralCategory(count) {
  try {
    if (!_pluralRules) _pluralRules = new Intl.PluralRules(_active);
    return _pluralRules.select(count);
  } catch {
    return count === 1 ? "one" : "other";
  }
}

function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : m,
  );
}

/**
 * Look up a display string by key, interpolating `{placeholder}` tokens from
 * `params`. Resolution: active catalog → English → the key itself (so a missing
 * string is visible rather than blank). Object-valued entries are plural forms
 * selected by numeric `params.count`.
 *
 * @param {string} key
 * @param {Object<string, any>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let msg = lookup(_messages, key);
  if (msg === undefined) msg = lookup(_fallback, key);
  if (msg === undefined) return key;

  if (msg && typeof msg === "object") {
    if (params && typeof params.count === "number") {
      const category = pluralCategory(params.count);
      msg = msg[category] ?? msg.other ?? msg.one;
      if (typeof msg !== "string") return key;
    } else {
      return key; // a group node with no count to disambiguate
    }
  }
  return interpolate(String(msg), params);
}

/**
 * Format a number for the active locale. Falls back to `String(value)` if
 * `Intl` rejects the options.
 * @param {number} value
 * @param {Intl.NumberFormatOptions} [opts]
 * @returns {string}
 */
export function formatNumber(value, opts) {
  try {
    return new Intl.NumberFormat(_active, opts).format(value);
  } catch {
    return String(value);
  }
}

/**
 * Format a date/timestamp for the active locale. Returns "" for an invalid date.
 * @param {number|string|Date} value
 * @param {Intl.DateTimeFormatOptions} [opts]
 * @returns {string}
 */
export function formatDate(
  value,
  opts = { dateStyle: "medium", timeStyle: "short" },
) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(_active, opts).format(d);
  } catch {
    return d.toISOString();
  }
}

/**
 * Swap the active catalog. Called by `init()` and directly by tests. Reflects
 * the language on `<html lang>` for accessibility.
 * @param {{active?:string,lang?:string,messages?:object,fallback?:object}} payload
 * @returns {string} the resolved active locale
 */
export function applyCatalog({ active, lang, messages, fallback } = {}) {
  _active = active || "en";
  _lang = lang || _active.split("-")[0];
  _messages = messages || EN;
  _fallback = fallback || EN;
  _pluralRules = null;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = _lang;
  }
  return _active;
}

/** The active locale (e.g. "en", "en-GB"). */
export function getLocale() {
  return _active;
}

/** The active language subtag (e.g. "en"). */
export function getLang() {
  return _lang;
}

/**
 * Load the active locale's catalog from the main process and apply it. Awaited
 * once in app.js before the first render. Any failure leaves the embedded
 * English in place, so the UI is never blank.
 * @returns {Promise<string>} the resolved active locale
 */
export async function init() {
  try {
    const payload = await window?.porthippo?.i18n?.load?.();
    if (payload) applyCatalog(payload);
  } catch {
    // Keep the embedded English catalog.
  }
  return _active;
}
