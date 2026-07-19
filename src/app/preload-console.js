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

"use strict";

// Minimal preload for a standalone console (terminal) window (console.html,
// Feature 200). Exposes only the byte pipe the embedded xterm.js needs to relay
// an ssh2 shell — deliberately narrow: a console window has no business reaching
// the store / engine surface of the main bridge.
//
// The streaming channels are one-way `send`/`on` (not request/response
// `invoke`/`handle`), so they carry high-frequency keystrokes + output without a
// round-trip and stay outside the invoke/handle IPC-parity guard. Each window
// owns exactly one session, so main routes its output here by webContents; the
// renderer still stamps its `sessionId` (read from the window URL) on every
// outbound message so main can look the session up.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jumphippoConsole", {
  platform: process.platform,

  // The terminal is sized and ready — main dials out and opens the shell.
  ready: (sessionId, cols, rows) =>
    ipcRenderer.send("console:ready", { sessionId, cols, rows }),
  // A keystroke (or paste) the user typed into the terminal.
  input: (sessionId, data) =>
    ipcRenderer.send("console:input", { sessionId, data }),
  // The terminal grid was resized (rows/cols) — reshape the remote pty.
  resize: (sessionId, cols, rows) =>
    ipcRenderer.send("console:resize", { sessionId, cols, rows }),
  // The window is closing — end the SSH session.
  close: (sessionId) => ipcRenderer.send("console:close", { sessionId }),

  // Shell output (raw bytes as a Uint8Array — byte-safe for split UTF-8).
  onData: (cb) =>
    ipcRenderer.on("console:data", (_event, payload) => cb(payload)),
  // The session ended (shell exit, dropped connection, or connect failure).
  onClosed: (cb) =>
    ipcRenderer.on("console:closed", (_event, payload) => cb(payload)),
  // An optional status line (e.g. "connecting…").
  onStatus: (cb) =>
    ipcRenderer.on("console:status", (_event, payload) => cb(payload)),
});
