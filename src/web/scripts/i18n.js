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
  // The OS term for the privileged account (Unix vs Windows), used in warnings.
  "common.root": "root",
  "common.administrator": "Administrator",

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
  "def.delete.confirmWord": "delete",
  "def.delete.confirmPrompt": "Type “{word}” to confirm.",

  // ── Tunnel editor (modal) ───────────────────────────────────────────────
  "editor.newTitle": "New tunnel",
  "editor.editTitle": "Edit tunnel",
  "editor.name": "Name",

  // Forwarding type (Feature 110): local (ssh -L), remote (ssh -R), dynamic (ssh -D).
  "editor.type": "Forwarding type",
  "editor.type.local": "Local",
  "editor.type.local.desc":
    "Forward a local port through the SSH server to a destination (ssh -L). The most common tunnel.",
  "editor.type.remote": "Remote",
  "editor.type.remote.desc":
    "Bind a port on the SSH server and forward it back to a target on this machine (ssh -R).",
  "editor.type.dynamic": "Dynamic (SOCKS)",
  "editor.type.dynamic.desc":
    "Run a local SOCKS5 proxy that forwards each request through the SSH server (ssh -D).",

  // Remote-forward fields (type = remote).
  "editor.remoteBind": "Remote bind",
  "editor.remoteBind.hint": "port on the server (or address:port)",
  "editor.remoteBind.placeholder": "8080  or  0.0.0.0:8080",
  "editor.remoteBind.desc":
    "The port bound on the SSH server that forwards back to your local target. A bare port binds the server’s loopback; an address:port can request a wider bind. A non-loopback bind needs the server’s GatewayPorts to be enabled.",
  "editor.remoteBind.gateway":
    "A non-loopback bind only works if the SSH server has GatewayPorts enabled.",
  "editor.localTarget": "Local target",
  "editor.localTarget.hint": "address:port on this machine",
  "editor.localTarget.placeholder": "127.0.0.1:3000",
  "editor.localTarget.desc":
    "The address and port on this machine that inbound connections on the remote port are forwarded to. Enter a port (bound to 127.0.0.1) or an address:port.",

  // Dynamic (SOCKS) field (type = dynamic).
  "editor.socksPort": "SOCKS port",
  "editor.socksPort.hint": "local SOCKS5 port or address:port",
  "editor.socksPort.placeholder": "1080  or  127.0.0.1:1080",
  "editor.socksPort.desc":
    "The local address the SOCKS5 proxy listens on. Point a browser or app at it and every connection is forwarded through the SSH server. Enter a port (bound to 127.0.0.1) or an address:port.",

  // Entry / Target / Exit address fields. See features/tunnel-address-fields.md.
  "editor.entryPort": "Entry port",
  "editor.entryPort.hint": "local port or address:port",
  "editor.entryPort.placeholder": "5432  or  127.0.0.1:5432",
  "editor.entryPort.desc":
    "The local address that represents the entry point of the tunnel on this machine. Enter a port on its own (bound to 127.0.0.1) or an address:port. An address must resolve to a loopback address, 0.0.0.0, or one of this machine’s own interfaces — it can’t point off-box.",
  "editor.entryPort.privileged":
    "Ports below 1024 need Port Hippo to run as {admin} to open them.",
  "editor.entryPort.notLocal":
    "“{host}” isn’t an address on this machine — the entry point can only bind a local address.",

  "editor.targetServer": "Target server",
  "editor.targetServer.hint": "destination server and ssh port",
  "editor.targetServer.placeholder": "db.example.com  or  db.example.com:22",
  "editor.targetServer.desc":
    "The remote server the tunnel connects to over SSH — the far end. Enter a host name or IP, optionally with an SSH port (host:port); the port defaults to 22. A host name is resolved on save (or test): from this machine when there are no jump hosts, otherwise from the last jump host.",

  "editor.exitPort": "Exit port",
  "editor.exitPort.hint": "Optional address:port",
  "editor.exitPort.placeholder": "127.0.0.1:5432  (optional)",
  "editor.exitPort.desc":
    "An optional local address and port on the target server that the tunnel connects to. Valid entries are address:port, address, port, or blank. Blank uses 127.0.0.1 and the same port as the Entry port; a host on its own reuses the Entry port; a port on its own uses 127.0.0.1. A host must resolve on the target server and be one of its interfaces, 0.0.0.0, or a loopback address — checked on save (or test) once the Target server (and any jump hosts) are set.",

  "editor.localPort.conflict": "Port {port} is already used by “{name}”.",

  // Inline address parse errors (shown against the owning field on save).
  "editor.address.entryRequired": "An entry port is required.",
  "editor.address.entryNoPort": "Enter a port, or an address:port.",
  "editor.address.targetRequired": "A target server is required.",
  "editor.address.portRange": "Port must be between 1 and 65535.",

  "editor.credential": "Credential",
  "editor.advanced": "Advanced",
  "editor.jumps": "Jump hosts",
  "editor.linger": "Idle linger (ms)",
  "editor.linger.hint":
    "How long to hold the SSH connection open after the last local client disconnects.",
  "editor.keepAlive": "Keep SSH connected while armed",
  "editor.enabled": "Arm on startup",
  "editor.autoReconnect": "Reconnect automatically if the connection drops",
  // Per-tunnel reconnect-policy override (Feature 130); blank inherits the global.
  "editor.retry": "Reconnect policy (override)",
  "editor.retry.hint":
    "Override the global reconnect policy for this tunnel. Leave a field blank to inherit the Settings value.",
  "editor.retry.inherit": "inherit",
  "editor.retry.baseMs": "Base backoff (ms)",
  "editor.retry.maxMs": "Max backoff (ms)",
  "editor.retry.maxAttempts": "Max attempts",
  "editor.duplicateSuffix": " (copy)",
  "editor.saveError": "Couldn’t save: {message}",

  // ── Resolution validation (Feature 100) ─────────────────────────────────
  "editor.resolve.unresolved": "“{host}” doesn’t resolve on this machine.",
  "editor.resolve.test": "Test resolution",
  "editor.resolve.testing": "Testing…",
  "editor.resolve.cancel": "Cancel test",
  "editor.resolve.hint":
    "Walks the jump chain and checks each host resolves from where it’s reached.",
  "editor.resolve.jump": "Jump {n}",
  "editor.resolve.targetRow": "Target server",
  "editor.resolve.exitRow": "Exit",
  "editor.resolve.ok": "reachable",
  "editor.resolve.fail": "unreachable",
  "editor.resolve.skipped": "not tested",
  "editor.resolve.allOk": "Every host resolved and was reachable.",
  "editor.resolve.someFailed": "Some hosts couldn’t be reached — see below.",
  "editor.resolve.error": "Couldn’t run the test: {message}",

  // ── Credential editor / picker ──────────────────────────────────────────
  "cred.newTitle": "New credential",
  "cred.editTitle": "Edit credential",
  "cred.label": "Name",
  "cred.label.placeholder": "e.g. Prod deploy key",
  "cred.user": "SSH user",
  "cred.user.placeholder": "username",
  "cred.new": "New…",
  "cred.choose": "Choose a credential…",
  // Feature 120: a password credential imported without its secret.
  "cred.needsSecret": "needs password",
  "cred.needsSecret.hint":
    "This credential was imported without its password. Enter it to connect.",

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
  // Static per-lamp hints for the sidebar traffic-light signal.
  "state.signal.red": "Indicates an error when lit",
  "state.signal.amber": "Indicates armed, but paused not connected",
  "state.signal.green": "Connected when lit",

  // ── Tunnels sidebar (master list) ───────────────────────────────────────
  "tunnels.title": "Tunnels",
  "tunnels.add": "Add tunnel",
  "tunnels.edit": "Edit tunnel",
  "tunnels.delete": "Delete tunnel",
  "tunnels.empty": "No tunnels yet.",
  "tunnels.emptyHint": "Add one to get started.",
  "tunnels.selectHint": "Select a tunnel to see its live details.",
  "tunnels.split.resize": "Resize the tunnel list",

  // ── Tunnel row right-click context menu (native OS menu) ────────────────
  "tunnels.menu.edit": "Edit",
  "tunnels.menu.pause": "Pause",
  "tunnels.menu.play": "Play",
  "tunnels.menu.arm": "Arm",
  "tunnels.menu.disarm": "Disarm",
  "tunnels.menu.assign": "Assign to group",
  "tunnels.menu.clone": "Clone",
  "tunnels.menu.delete": "Delete",

  // ── Tunnel groups (Feature 140) ─────────────────────────────────────────
  "group.newTitle": "New group",
  "group.editTitle": "Edit group",
  "group.label": "Name",
  "group.label.placeholder": "e.g. Work, Home lab",
  "group.color": "Colour",
  "group.color.blue": "Blue",
  "group.color.teal": "Teal",
  "group.color.green": "Green",
  "group.color.amber": "Amber",
  "group.color.violet": "Violet",
  "group.color.red": "Red",
  "group.ungrouped": "Ungrouped",
  "group.expand": "Expand group",
  "group.collapse": "Collapse group",
  "group.count": "{armed}/{total}",
  "group.traffic": "↑{up} ↓{down}",
  "group.armAll": "Arm all in group",
  "group.pauseAll": "Pause all in group",
  "group.resumeAll": "Resume all in group",
  "group.newEllipsis": "New group…",
  "group.menu.armAll": "Arm all",
  "group.menu.disarmAll": "Disarm all",
  "group.menu.pauseAll": "Pause all",
  "group.menu.resumeAll": "Resume all",
  "group.menu.edit": "Edit group…",
  "group.menu.delete": "Delete group…",
  "group.delete.message":
    "Delete group “{name}”? Its tunnels stay, just ungrouped.",

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
  "card.category.throughput": "Throughput",
  "card.category.transfer": "Transfer",
  "card.category.connections": "Connections",
  "card.category.status": "Status",
  "card.category.activity": "Activity",
  "card.download": "Download",
  "card.peakDownload": "Peak download",
  "card.upload": "Upload",
  "card.peakUpload": "Peak upload",
  "card.combinedThroughput": "Combined throughput",
  "card.avgThroughput": "Average throughput",
  "card.connections": "Connections",
  "card.peakConnections": "Peak connections",
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
  // Reconnect card (Feature 130): live attempt count + countdown while retrying.
  "card.reconnect": "Reconnect",
  "card.reconnect.retrying": "attempt {attempt} · retry in {seconds}s",
  "card.reconnect.attempt": "attempt {attempt}…",
  "card.none": "—",

  // ── Tunnel error card → full-error dialog ───────────────────────────────
  "error.card.hint": "Show the full error",
  "error.dialog.title": "Tunnel error — {name}",
  "error.dialog.unknown":
    "The tunnel reported an error, but no details are available.",

  // ── Errors card → error/warning history dialog ──────────────────────────
  "errors.card.hint": "Show the error history",
  "errors.dialog.title": "Error history — {name}",
  "errors.dialog.empty": "No errors recorded yet.",
  "errors.level.error": "Error",
  "errors.level.warning": "Warning",

  // ── View mode + all-tunnels list (table) ────────────────────────────────
  // The header toggle's hint names the mode it switches TO (opposite of current).
  "view.mode.showCards": "Display Cards",
  "view.mode.showList": "Display List",
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
  "settings.nav.reliability": "Notifications",
  "settings.nav.security": "Security",
  "settings.nav.hostkeys": "Host Keys",
  "settings.nav.data": "Import/Export",

  "settings.appearance.theme": "Theme",
  "settings.appearance.theme.system": "System",
  "settings.appearance.theme.light": "Light",
  "settings.appearance.theme.dark": "Dark",
  "settings.appearance.language": "Language",
  "settings.appearance.language.system": "System default",
  "settings.appearance.fontSize": "Font size",
  "settings.appearance.fontSize.hint":
    "Scales the whole interface. Cmd/Ctrl with +, - or 0 also adjusts it.",
  "settings.appearance.fontFamily": "Font",
  "settings.appearance.fontFamily.system": "System default",

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

  // ── Settings → Notifications & reliability (Feature 130) ─────────────────
  "settings.reliability.help":
    "Get told when a tunnel drops, recovers or gives up — and tune how Port Hippo detects a dead connection and retries it.",
  "settings.reliability.notificationsEnabled": "Show desktop notifications",
  "settings.reliability.notificationsEnabled.hint":
    "The master switch. Your operating system’s Do Not Disturb is always respected.",
  "settings.reliability.notifyOnDrop": "Notify when a tunnel drops",
  "settings.reliability.notifyOnRecover": "Notify when a tunnel recovers",
  "settings.reliability.notifyOnGiveUp": "Notify when a tunnel gives up",
  "settings.reliability.cooldown": "Notification cooldown (ms)",
  "settings.reliability.cooldown.hint":
    "The minimum gap between repeated drop notices for one tunnel, so a flapping connection can’t spam you.",
  "settings.reliability.keepalive": "SSH keepalive interval (seconds)",
  "settings.reliability.keepalive.hint":
    "How often to probe an idle SSH connection so a dead peer is detected in seconds instead of minutes. 0 turns probing off.",
  "settings.reliability.reconnectBase": "Reconnect base backoff (ms)",
  "settings.reliability.reconnectBase.hint":
    "The first reconnect delay after a drop; it doubles each attempt up to the maximum.",
  "settings.reliability.reconnectMax": "Reconnect max backoff (ms)",
  "settings.reliability.reconnectAttempts":
    "Reconnect attempts before giving up",
  "settings.reliability.reconnectAttempts.hint":
    "How many times to retry before a tunnel gives up (tunnels set to keep SSH connected always keep trying).",

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

  // ── Host Keys tab (accepted SSH host-key fingerprints, TOFU) ────────────
  "settings.hostkeys.heading": "Trusted SSH host keys",
  "settings.hostkeys.help":
    "Fingerprints you accepted the first time you connected to each host. Forget one to be prompted to trust it again on the next connection — this is also how you re-trust a host after its key legitimately changes.",
  "settings.hostkeys.empty": "No host keys trusted yet.",
  "settings.hostkeys.loadError": "Couldn’t load your trusted host keys.",
  "settings.hostkeys.retry": "Retry",
  "settings.hostkeys.added": "Added {date}",
  "settings.hostkeys.forget": "Forget",
  "settings.hostkeys.forgetAria": "Forget host key for {host}",
  "settings.hostkeys.confirm": "Forget this key?",
  "settings.hostkeys.tab.porthippo": "Port Hippo",
  "settings.hostkeys.tab.os": "Operating System",
  "settings.hostkeys.os.help":
    "Host keys from your operating system’s SSH configuration. Port Hippo checks these too but can’t change them — manage them manually.",
  "settings.hostkeys.os.path": "Found in {path}",
  "settings.hostkeys.os.empty":
    "No host keys found in your OS SSH configuration.",
  "settings.hostkeys.os.hashed": "(hashed host)",

  // ── Unlock-on-launch prompt (master-password mode boots locked) ─────────
  "unlock.title": "Unlock secrets",
  "unlock.later": "Not now",

  // ── Import / export (Settings → Data, Feature 120) ──────────────────────
  "io.data.help":
    "Back up your tunnels, credentials and jump hosts to a portable file, restore them on another machine, or seed Port Hippo from your SSH config.",
  "io.data.export": "Export bundle…",
  "io.data.exportDesc":
    "Save your tunnels, credentials and jump hosts to a .porthippo file.",
  "io.data.importBundle": "Import bundle…",
  "io.data.importBundleDesc":
    "Restore tunnels, credentials and jump hosts from a .porthippo file.",
  "io.data.importSsh": "Import from SSH config…",
  "io.data.importSshDesc":
    "Propose tunnels, credentials and jump hosts from your ~/.ssh/config.",

  // Export dialog.
  "io.export.title": "Export bundle",
  "io.export.includeSettings": "Include app settings",
  "io.export.secrets": "Secrets",
  "io.export.secrets.stripped": "Don’t include passwords",
  "io.export.secrets.strippedDesc":
    "The safest option. Imported credentials will need their passwords re-entered.",
  "io.export.secrets.encp": "Protect with a passphrase",
  "io.export.secrets.encpDesc":
    "Encrypt secrets with a passphrase you choose. You’ll need it to import them.",
  "io.export.passphrase": "Passphrase",
  "io.export.passphraseConfirm": "Confirm passphrase",
  "io.export.passphraseWarn":
    "If you forget this passphrase, the secrets in this bundle can’t be recovered.",
  "io.export.submit": "Export…",
  "io.export.done": "Bundle exported.",
  "io.export.error.passphraseRequired": "Enter a passphrase.",
  "io.export.error.passphraseMismatch": "The passphrases don’t match.",

  // Import bundle dialog.
  "io.import.title": "Import bundle",
  "io.import.file": "From {name}",
  "io.import.nothing": "This bundle has no records to import.",
  "io.import.section.tunnels": "Tunnels",
  "io.import.section.credentials": "Credentials",
  "io.import.section.jumpHosts": "Jump hosts",
  "io.import.status.add": "{n} new",
  "io.import.status.update": "{n} update",
  "io.import.status.conflict": "{n} conflict",
  "io.import.mode": "How to import",
  "io.import.mode.merge": "Merge",
  "io.import.mode.mergeDesc":
    "Add new records and keep what you already have. Existing secrets are never overwritten.",
  "io.import.mode.replace": "Replace everything",
  "io.import.mode.replaceDesc":
    "Delete all current tunnels, credentials and jump hosts, then load the bundle.",
  "io.import.replaceWarn":
    "This permanently deletes your current tunnels, credentials and jump hosts.",
  "io.import.passphrase": "Bundle passphrase",
  "io.import.submit": "Import",
  "io.import.done": "Import complete.",
  "io.import.error.invalid": "That file isn’t a valid Port Hippo bundle.",
  "io.import.error.badPassphrase": "Incorrect passphrase.",
  "io.import.error.passphraseRequired": "Enter the bundle’s passphrase.",
  "io.import.error.dangling":
    "The bundle is inconsistent (a broken reference) and wasn’t imported.",
  "io.import.error.generic": "The import failed. Nothing was changed.",

  // SSH-config import dialog.
  "io.ssh.title": "Import from SSH config",
  "io.ssh.desc":
    "Choose which hosts to add as tunnels. Nothing is written until you import.",
  "io.ssh.note":
    "Each selected host also imports the credential and jump hosts it needs. Review the drafted tunnels afterwards — the forwarded ports are placeholders.",
  "io.ssh.empty": "No usable hosts were found in that SSH config.",
  "io.ssh.error": "That SSH config couldn’t be read.",
  "io.ssh.host.via": "{host} · via {jumps}",
  "io.ssh.submit": "Import {count}",
  "io.ssh.done": "Imported {count} tunnel(s).",

  // ── Native menu (rendered by the MAIN process via its own i18n) ─────────
  "menu.file": "File",
  "menu.edit": "Edit",
  "menu.window": "Window",
  "menu.help": "Help",
  "menu.newTunnel": "New Tunnel",
  "menu.armAll": "Arm All Tunnels",
  "menu.disarmAll": "Disarm All Tunnels",
  "menu.groups": "Groups",
  "menu.group.armAll": "Arm All",
  "menu.group.disarmAll": "Disarm All",
  "menu.settings": "Settings…",
  "menu.view": "View",
  "menu.viewDefinition": "Definition",
  "menu.viewMonitoring": "Monitoring",
  "menu.userGuide": "Port Hippo User Guide",
  "menu.copyDiagnostics": "Copy Diagnostics",
  "menu.showLogs": "Show Logs Folder",
  "menu.about": "About Port Hippo",
  "menu.hide": "Hide Port Hippo",
  "menu.quit": "Quit Port Hippo",
  "menu.checkUpdates": "Check for Updates…",
  "menu.fontIncrease": "Increase Font Size",
  "menu.fontDecrease": "Decrease Font Size",
  "menu.fontReset": "Reset Font Size",

  // ── Tray (MAIN process) ─────────────────────────────────────────────────
  "tray.show": "Show Port Hippo",
  "tray.tunnels": "Tunnels",
  "tray.armAll": "Arm All",
  "tray.disarmAll": "Disarm All",
  "tray.groups": "Groups",
  "tray.group.armAll": "Arm All",
  "tray.group.disarmAll": "Disarm All",
  "tray.settings": "Settings…",
  "tray.copyDiagnostics": "Copy Diagnostics",
  "tray.quit": "Quit Port Hippo",
  "tray.tooltip": "Port Hippo — {active} of {total} active",
  "tray.tooltip.none": "Port Hippo — no tunnels",
  // Aggregate-health summary line, shown only when not fully healthy (Feature 130).
  "tray.health.reconnecting": "Reconnecting {n} tunnel(s)…",
  "tray.health.error": "{n} tunnel(s) need attention",

  // ── Shell notifications / dialogs (MAIN process) ────────────────────────
  "shell.hide.title": "Port Hippo is still running",
  "shell.hide.body":
    "Tunnels stay active in the background. Use the tray icon to show the window or quit.",
  "shell.quit.title": "Quit Port Hippo?",
  "shell.quit.message":
    "Quitting disarms every tunnel and closes its SSH connections.",
  "shell.quit.confirm": "Quit",
  "shell.diagnostics.copied": "Diagnostics copied to the clipboard.",

  // ── Health notifications (MAIN process, Feature 130) ────────────────────
  // Payloads carry the tunnel NAME only — never a host, user, or secret.
  "notify.dropped.title": "Tunnel dropped",
  "notify.dropped.body": "“{name}” lost its SSH connection. Reconnecting…",
  "notify.recovered.title": "Tunnel recovered",
  "notify.recovered.body": "“{name}” reconnected.",
  "notify.gaveUp.title": "Tunnel gave up",
  "notify.gaveUp.body":
    "“{name}” couldn’t reconnect. Open Port Hippo to retry.",
  "notify.hostkeyChanged.title": "⚠ SSH host key changed",
  "notify.hostkeyChanged.body":
    "“{name}” was refused because its host key changed. Review it in Port Hippo.",
};

// ── Module state ─────────────────────────────────────────────────────────────
// Default to the embedded English so `t()` works before `init()` resolves.
let _active = "en";
let _lang = "en";
let _messages = EN;
let _fallback = EN;
let _pluralRules = null;

/**
 * Locale options for the settings picker. `system` follows the OS locale; every
 * other row is a shipped `locales/<value>.json` catalog. Labels are ENDONYMS —
 * each language's own name — so a speaker recognises it whatever the UI's current
 * language is (matching how `English` is a literal label, not a `t()` key). `zh`
 * ships Simplified Chinese; the label says so since the subtag-only resolver can't
 * distinguish Traditional.
 */
export const LOCALE_OPTIONS = [
  { value: "system", labelKey: "settings.appearance.language.system" },
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "zh", label: "中文（简体）" },
  { value: "ja", label: "日本語" },
  { value: "it", label: "Italiano" },
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
