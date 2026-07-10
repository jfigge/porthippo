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
 * settings-store.js — App-wide preferences (no secrets). A single JSON document
 * under userData; `get()` returns the stored values layered over the defaults,
 * `set(patch)` shallow-merges a patch and persists. Later features read these:
 * theme + language, the default lingerMs / bindHost / keep-alive seeded into new
 * definitions, and the Feature 60 shell behaviour (launch-at-login, start
 * minimized, arm-on-launch, confirm-on-quit).
 */
"use strict";

const io = require("./io");

const DEFAULTS = Object.freeze({
  // ── Appearance ────────────────────────────────────────────────────────────
  theme: "system", // "system" | "light" | "dark"
  language: "system", // "system" | a BCP-47 subtag (e.g. "en"); Feature 60 i18n

  // ── Defaults seeded into new tunnel definitions ───────────────────────────
  defaultLingerMs: 10000, // idle grace before SSH teardown
  defaultBindHost: "127.0.0.1", // loopback by default (LAN exposure is opt-in)
  defaultKeepAlive: false, // hold SSH open while armed, by default

  // ── Shell / view state ────────────────────────────────────────────────────
  viewMode: "definition", // "definition" | "monitoring" (Feature 40 shell)
  monitorFilter: "all", // "all" | "active" — Monitoring view list filter (Feature 50)

  // ── Feature 60 behaviour ──────────────────────────────────────────────────
  launchAtLogin: false, // start Port Hippo at OS login
  startMinimized: false, // when launched at login, start hidden in the tray
  armOnLaunch: true, // arm enabled definitions on startup (bind their listeners)
  confirmOnQuit: false, // ask before quitting (tears down live tunnels)
});

class SettingsStore {
  /**
   * @param {import('./paths').Paths} paths
   */
  constructor(paths) {
    this._paths = paths;
  }

  _read() {
    const doc = io.readJSON(this._paths.settingsPath());
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  }

  /** Current settings: stored values layered over the defaults. */
  get() {
    // Drop the internal schemaVersion stamp from the renderer-facing view.
    const { schemaVersion: _v, ...stored } = this._read();
    return { ...DEFAULTS, ...stored };
  }

  /**
   * Shallow-merge `patch` into the stored settings and persist. Returns the full
   * merged settings (defaults + stored).
   * @param {object} patch
   * @returns {object}
   */
  set(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      const err = new Error("settings patch must be an object");
      err.code = "INVALID_ARG";
      throw err;
    }
    const { schemaVersion: _v, ...stored } = this._read();
    const next = { ...stored, ...patch };
    io.writeJSON(this._paths.settingsPath(), next);
    return { ...DEFAULTS, ...next };
  }
}

module.exports = { SettingsStore, DEFAULTS };
