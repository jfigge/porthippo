/**
 * terminal-entry.js — Terminal-emulator bundle entry point.
 *
 * Bundles `@xterm/xterm` (the VT/ANSI terminal emulator) + `@xterm/addon-fit`
 * (sizes the terminal grid to its container) into one ES module for the console
 * window (src/web/console.html → console-window.js), which relays an ssh2 shell
 * channel to and from the emulator. xterm renders the remote shell's output
 * (cursor addressing, colours, alternate screen for vim/htop, …) and reports the
 * user's keystrokes + resize events back over the console:* IPC bridge.
 *
 * This file is NOT imported at runtime — it is compiled by esbuild into
 *   web/scripts/vendor/xterm.js
 * (and xterm's stylesheet copied to web/scripts/vendor/xterm.css) via
 * `npm run vendor-terminal` (or `make vendor-terminal`). Regenerate the bundle
 * after bumping @xterm/xterm or @xterm/addon-fit.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export { Terminal, FitAddon };
