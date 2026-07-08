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
  "def.list.moveUp": "Move up",
  "def.list.moveDown": "Move down",
  "def.list.delete": "Delete tunnel",
  "def.list.summary": "localhost:{localPort} → {host}:{port}",
  "def.editor.none": "Select a tunnel to edit, or create a new one.",
  "def.unnamed": "Untitled tunnel",

  "def.delete.title": "Delete tunnel?",
  "def.delete.message": "Delete “{name}”? This can’t be undone.",

  // ── Tunnel editor ───────────────────────────────────────────────────────
  "editor.newTitle": "New tunnel",
  "editor.name": "Name",
  "editor.local": "Local binding",
  "editor.localPort": "Local port",
  "editor.bindHost": "Bind address",
  "editor.bindHost.hint": "127.0.0.1 keeps the tunnel private to this machine.",
  "editor.bindHost.warning":
    "This binds beyond loopback — reachable by other machines on your network.",
  "editor.destination": "Destination",
  "editor.destination.host": "Host",
  "editor.destination.port": "Port",
  "editor.sshServer": "SSH server",
  "editor.jumps": "Jump hosts",
  "editor.options": "Options",
  "editor.linger": "Idle linger (ms)",
  "editor.linger.hint":
    "How long to hold the SSH connection open after the last local client disconnects.",
  "editor.keepAlive": "Keep SSH connected while armed",
  "editor.enabled": "Arm on startup",
  "editor.autoReconnect": "Reconnect automatically if the connection drops",
  "editor.save": "Save",
  "editor.cancel": "Cancel",
  "editor.saveError": "Couldn’t save: {message}",

  // ── Hop (SSH server / jump host) ────────────────────────────────────────
  "hop.host": "Host",
  "hop.port": "Port",
  "hop.user": "User",
  "jumps.add": "Add jump host",
  "jumps.empty": "No jump hosts — a direct connection.",
  "jumps.label": "Hop {n}",
  "jumps.remove": "Remove jump host",
  "jumps.moveUp": "Move up",
  "jumps.moveDown": "Move down",

  // ── Auth editor ─────────────────────────────────────────────────────────
  "auth.title": "Authentication",
  "auth.add": "Add method",
  "auth.method": "Method {n}",
  "auth.remove": "Remove method",
  "auth.moveUp": "Move up",
  "auth.moveDown": "Move down",
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
  "auth.secretPlaceholder": "Enter a new value to change",
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

  // ── App shell / header (Feature 60) ─────────────────────────────────────
  "header.settings": "Settings",

  // ── Settings panel (Feature 60) ─────────────────────────────────────────
  "settings.title": "Settings",
  "settings.nav.appearance": "Appearance",
  "settings.nav.defaults": "Defaults",
  "settings.nav.behaviour": "Behaviour",

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
  "menu.viewSplit": "Split",
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
