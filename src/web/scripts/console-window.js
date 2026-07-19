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

/**
 * console-window.js — bootstrap for a standalone console (terminal) window
 * (console.html, Feature 200).
 *
 * Mounts the vendored xterm.js emulator, sizes it to the window, and bridges it to
 * the ssh2 shell in the main process over the narrow `window.jumphippoConsole`
 * preload: the shell's output bytes (`onData`) are written to the terminal; the
 * user's keystrokes (`term.onData`) and resizes (`term.onResize` / a
 * ResizeObserver-driven fit) are sent back. Connect is deferred until the terminal
 * is sized, so the remote pty is created at the right dimensions: we open + fit,
 * then signal `ready(cols, rows)`.
 *
 * The window is created + owned by the main process (openConsoleWindow in main.js);
 * `sessionId` is passed in the window URL and stamped on every outbound message.
 */

"use strict";

import { Terminal, FitAddon } from "./vendor/xterm.js";

const params = new URLSearchParams(location.search);
const sessionId = params.get("sessionId") || "";
const title = params.get("title") || "Console";
document.title = title;

/** Read a theme token from the active palette so the terminal matches the app. */
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

const term = new Terminal({
  cursorBlink: true,
  scrollback: 5000,
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 13,
  theme: {
    background: token("--color-crust", "#101010"),
    foreground: token("--color-text", "#e8e8e8"),
    cursor: token("--color-text", "#e8e8e8"),
    cursorAccent: token("--color-crust", "#101010"),
    selectionBackground: token("--color-overlay", "#686868"),
  },
});

const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.getElementById("terminal"));

/** Fit the grid to the window; returns the resulting {cols, rows}. */
function fitNow() {
  try {
    fit.fit();
  } catch {
    /* container not laid out yet */
  }
  return { cols: term.cols, rows: term.rows };
}

// ── Wire the byte pipe to main ────────────────────────────────────────────────
// Output → terminal (raw bytes; xterm handles the UTF-8 decode + control codes).
window.jumphippoConsole.onData(({ data }) => {
  term.write(data instanceof Uint8Array ? data : new Uint8Array(data));
});

// Keystrokes / paste → shell.
term.onData((data) => window.jumphippoConsole.input(sessionId, data));

// Grid resize → remote pty. onResize fires whenever fit() changes cols/rows.
term.onResize(({ cols, rows }) =>
  window.jumphippoConsole.resize(sessionId, cols, rows),
);

// The session ended — surface why and stop accepting input (the shell is gone).
window.jumphippoConsole.onClosed(({ reason, error } = {}) => {
  term.options.disableStdin = true;
  const color = error ? 31 : 90; // red on failure, dim grey on a clean close
  const msg = reason || "connection closed";
  term.write(`\r\n\x1b[${color}m[${msg}]\x1b[0m\r\n`);
});

// Optional status line (e.g. "connecting…") before the first byte arrives.
window.jumphippoConsole.onStatus(({ message } = {}) => {
  if (message) term.write(`\x1b[90m${message}\x1b[0m\r\n`);
});

// ── Startup: size, connect, focus ─────────────────────────────────────────────
const initial = fitNow();
window.jumphippoConsole.ready(sessionId, initial.cols, initial.rows);
term.focus();

// Keep the grid matched to the window; fit() emits onResize → resize IPC.
const ro = new ResizeObserver(() => fitNow());
ro.observe(document.getElementById("terminal"));

// Refocus the terminal when the window regains focus (so typing lands there).
window.addEventListener("focus", () => term.focus());
