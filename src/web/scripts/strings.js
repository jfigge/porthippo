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

// strings.js — the single source of every user-facing string in the renderer,
// plus a `t(key, params?)` lookup. Feature 60 adds real i18n; until then this is
// the seam: components already call `t("area.thing")`, so that pass only has to
// swap this table for per-locale catalogs and localize the values — no component
// changes. Keys follow Rest Hippo's `area.component.label` convention; `{name}`
// placeholders interpolate from `params`.

const STRINGS = {
  // ── Common ──────────────────────────────────────────────────────────────
  "common.confirm": "Confirm",
  "common.cancel": "Cancel",
  "common.delete": "Delete",
  "common.save": "Save",
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
};

/**
 * Look up a display string by key, interpolating `{placeholder}` tokens from
 * `params`. An unknown key returns the key itself (so a missing string is
 * visible rather than blank — the same failure mode Rest Hippo's `t()` uses).
 *
 * @param {string} key
 * @param {Object<string, any>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(STRINGS, key)
    ? STRINGS[key]
    : key;
  if (params) {
    s = s.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(params, name)
        ? String(params[name])
        : m,
    );
  }
  return s;
}
