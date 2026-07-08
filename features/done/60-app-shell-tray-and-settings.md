# Feature 60 — App shell: tray, settings & platform integration

## Context
By this stage Port Hippo is functionally complete: define tunnels, run them on-demand,
watch them live. But it still behaves like an ordinary windowed app that quits when you
close the window — wrong for a **background utility whose whole job is to keep tunnels
alive**. This stage makes it a proper always-available tool: a **system-tray / menu-bar
presence**, **hide-to-tray** so closing the window keeps tunnels running, **launch at
login**, a real **settings** surface, native menus, notifications, and the operational
plumbing Rest Hippo has (single-instance lock, rotating logs, diagnostics). It also lands
the **i18n seam** the UI stages were written to slot into.

## Goal
Port Hippo runs as a background-capable app: a tray icon shows overall status and offers
quick arm/disarm + show/quit; closing the window hides to tray while tunnels keep running;
a settings panel controls launch-at-login, default linger, default bind host, theme, and
language; single-instance lock, rotating logs, and a diagnostics report are in place; and
user-facing strings route through a `t()` i18n seam.

## Design decisions (settled — do not relitigate)
- **Tray is the primary presence.** A `Tray` with a context menu (Show/Hide window, an
  arm-all / disarm-all pair, a per-tunnel quick submenu showing state, Settings, Quit) and a
  status-reflecting icon/tooltip (e.g. "3 tunnels, 1 active"). Left-click shows/focuses the
  window (platform-appropriate). The tray is created in main and fed by the engine's
  state/stats.
- **Close hides, quit quits.** The window `close` event hides to tray instead of quitting
  (so tunnels stay up); real quit is via the tray's Quit, the app menu, or Cmd/Ctrl-Q,
  which sets a "really quitting" flag and calls `engine.disarmAll()` for clean teardown. A
  first-time close shows a one-off "still running in the tray" notification.
- **Single-instance lock** (ported from Rest Hippo): a second launch focuses the existing
  window and exits — the store's single-writer model requires it.
- **Launch at login** via Electron's `app.setLoginItemSettings` (macOS/Windows) and a
  generated `.desktop` autostart entry on Linux; a settings toggle, off by default.
- **Settings is a panel, not scattered prefs.** One `SettingsPopup` (Rest Hippo pattern)
  over `settings-store` (Feature 10): appearance (theme, language), defaults (linger, bind
  host, all/active default, keep-alive default), behaviour (launch at login, start
  minimized to tray, arm-enabled-tunnels-on-launch, confirm-on-quit). Changes broadcast
  `porthippo:settings-changed`.
- **i18n seam now, catalogs pragmatic.** Introduce Rest Hippo's `t()` architecture:
  renderer `i18n.js` (`t`, `formatNumber`, `formatDate`, `init()`), main `i18n.js` loading
  the active catalog over IPC, catalogs under `src/web/locales/`. Ship **English complete**;
  additional locales are an explicit, separable follow-on (the seam makes adding them
  mechanical). Retro-route the strings the UI stages centralized. A no-hardcoded-strings
  guard is optional at this scale — decide, and if adopted, wire it into `make test`.
- **Logging + diagnostics** ported from Rest Hippo: rotating log under `userData/logs`
  (`logger.js`), a `diagnostics.js` "copy report" (versions, platform, tunnel count with
  **secrets redacted**, recent log tail) reachable from Help/tray. No telemetry, no phone
  home.
- **Native app menu** with the usual roles + Port Hippo items (Preferences, About,
  Show/Hide, Quit), localized.

## Implementation steps
1. **Single-instance lock** in `main.js` (skip under `--hot-reload`), focusing the window on
   second launch.
2. **Tray.** `src/app/tray.js`: build the `Tray`, its menu, and status icon/tooltip;
   subscribe to engine state/stats to keep the menu + tooltip current; wire arm-all/
   disarm-all/show/settings/quit. Provide tray icon assets (template image on macOS).
3. **Window lifecycle.** Intercept `close` → hide (unless `app.isQuitting`); add tray
   Show/Hide; on real quit set `isQuitting`, `engine.disarmAll()`, then quit. First-time
   hide notification.
4. **Launch at login.** `login-item.js` wrapping `setLoginItemSettings` + Linux
   `.desktop` autostart; a settings toggle; honor "start minimized to tray".
5. **Startup arming.** On launch (post-store-load), optionally `engine.armAll()` for
   enabled definitions per the "arm on launch" setting.
6. **Settings panel.** `settings-popup.js` (renderer) over `settings-store`; sections as
   above; live-apply theme/language; broadcast `porthippo:settings-changed`; consumers
   (views, engine defaults) react.
7. **i18n.** Port `i18n.js` (main + renderer) and create `src/web/locales/en.json`; route
   the centralized UI strings (Features 40/50) and new shell/tray/menu/settings strings
   through `t()`; `await i18n.init()` before first render in `app.js`. Localize main-process
   menu/tray/dialog strings via the main `i18n.js`.
8. **Logging + diagnostics.** Port `logger.js` (install console tee + rotating file) and
   `diagnostics.js` (redacted report); expose a "Copy diagnostics" action (Help menu/tray)
   over IPC.
9. **Native menu** (`Menu.setApplicationMenu`) with localized roles + Port Hippo items.
10. **Tests.** `settings-store` round-trip (already from Feature 10 — extend for new keys),
    `i18n.test.js` (en catalog completeness + `t()` fallback), a `login-item` unit test
    (mock the Electron API), and a redaction test for `diagnostics` (no secrets in the
    report). Fold into `make test`.
11. **License headers** on all new files; update `CLAUDE.md` (tray/lifecycle/i18n/logging
    conventions).

## Acceptance criteria
- A tray icon shows overall tunnel status and offers Show/Hide, arm-all/disarm-all,
  Settings, and Quit; its tooltip/menu track live state.
- Closing the window **hides to tray and keeps tunnels running**; Quit (tray/menu/shortcut)
  cleanly disarms all tunnels and exits; a first-time hide shows the "running in tray" hint.
- A second launch focuses the existing window instead of starting a duplicate.
- Launch-at-login can be toggled and takes effect on the current OS; "start minimized" is
  honored.
- The settings panel controls theme, language, default linger/bind-host, and behaviour
  toggles, applying live and persisting.
- Strings route through `t()` with a complete English catalog; a rotating log exists under
  `userData/logs`; the diagnostics report copies **with secrets redacted**.
- New tests pass; `make test` green; new files carry the license header.

## Constraints
- All native integration (tray, login item, menus, logging) in **main**; the renderer drives
  it via `window.porthippo.*` and reacts to `porthippo:*` events.
- Hide-to-tray must never drop live tunnels; only explicit Quit disarms.
- Diagnostics/logs must never contain secrets or private-key material (redact + test it).
- No telemetry or remote calls. i18n via the `t()` seam only — no hardcoded display strings
  in new code.

## Verify
`make fmt && make lint && make test`, then `make debug`: confirm the tray appears with a
live status tooltip; arm a tunnel, close the window, and confirm the app stays in the tray
with the tunnel still connected (traffic still flows); Quit from the tray and confirm clean
teardown. Toggle launch-at-login and verify the OS login-item state. Open Settings, change
theme/language/default linger, and confirm live apply + persistence. Trigger "Copy
diagnostics" and confirm the report has no secrets.
