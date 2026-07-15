# Tray & Background

Port Hippo is a **background utility**. It's designed to stay running quietly so
your armed tunnels keep working — you don't need its window open for tunnels to
open on demand.

## The tray is home

Port Hippo lives in your system tray (menu bar on macOS, notification area on
Windows, status area on Linux). The tray icon reflects overall tunnel activity and
gives you quick actions:

- Show / focus the main window.
- **Arm All** / **Disarm All** tunnels.
- Arm or disarm an individual tunnel.
- Copy a diagnostics report, open Settings, and quit.

## Closing the window keeps tunnels alive

**Closing the window hides it to the tray — it does not quit the app.** Your armed
tunnels keep listening and continue to open on demand. Re-open the window from the
tray (or the dock/taskbar) whenever you need it.

The first time the window hides, Port Hippo shows a one-time notice so you know
it's still running in the tray.

### Only Quit tears tunnels down

Tunnels are torn down **only** when you explicitly **Quit** — from the tray menu,
the application menu, or `Cmd/Ctrl+Q`. On quit, Port Hippo closes every live SSH
connection cleanly (so remote servers see a graceful disconnect) and then exits.

You can enable **Confirm before quitting** in **Settings → Behaviour** so an
accidental Quit that would drop live tunnels asks first.

## Launch at login

Turn on **Launch at login** in **Settings → Behaviour** to have Port Hippo start
with your OS. Combined with *arm on launch* (below), your tunnels are ready the
moment you sign in.

- macOS / Windows use the OS login-item mechanism.
- Linux installs a desktop autostart entry.

This is applied in packaged builds; it's a no-op when running from source.

## Start minimized

With **Start minimized** on, Port Hippo starts hidden in the tray — no window
appears, but enabled tunnels still arm. Ideal alongside *launch at login* for a
truly background setup.

## Arm on launch

**Arm enabled tunnels on startup** (on by default) binds every enabled tunnel's
entry port when Port Hippo starts, so they're listening immediately. Turn it off if
you'd rather arm tunnels by hand.

> If you use a **master password** for secret storage, the app starts **locked**
> and prompts you to unlock before it can decrypt credentials. Startup arming waits
> until you unlock. See [Security](security.md).

## Native menu

The application menu carries the same actions plus standard fare:

- **File** — New Tunnel, Arm All, Disarm All, Settings, Quit.
- **View** — zoom the interface (Increase / Decrease / Reset Font Size,
  `Cmd/Ctrl +` `-` `0`), full screen.
- **Help** — this User Guide, Copy Diagnostics, Show Logs Folder, Check for
  Updates.

## Appearance & language

**Settings → Appearance** controls how Port Hippo looks: the **Theme**
(System / Light / Dark), the interface **Font** and **Font size**, and the
**Language**.

Port Hippo ships in seven languages:

- **English**, **Français** (French), **Deutsch** (German), **Español**
  (Spanish), **中文（简体）** (Simplified Chinese), **日本語** (Japanese), and
  **Italiano** (Italian).

Pick one from the **Language** menu and the window reloads into that language —
the whole interface, the native menu, and the tray. Choose **System default** to
follow your operating system's language: if that's one of the seven above, Port
Hippo uses it automatically; otherwise it falls back to English. Any phrase a
translation hasn't covered also falls back to English, so you'll never see a
blank label.

> The product name **Port Hippo** and protocol terms (SSH, SOCKS) are the same in
> every language. This User Guide is currently available in English only.
