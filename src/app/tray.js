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
 * tray.js — the system-tray / menu-bar presence.
 *
 * Port Hippo is a background utility whose job is to keep tunnels alive, so the
 * tray is its primary always-available surface: a status-reflecting tooltip, a
 * per-tunnel quick submenu, arm-all/disarm-all, Show/Settings/Quit. It is fed by
 * `getStatus()` (a snapshot of `{ tunnels:[{id,name,state}], total, active }`
 * assembled in main from the store names + the engine states) and refreshed via
 * `update()` whenever the engine broadcasts a state/stats change.
 *
 * All Electron collaborators are injected so main owns the native surface.
 */
"use strict";

// States that count as "active" for the tooltip and control enablement.
const LIVE_STATES = new Set(["listening", "connecting", "connected", "paused"]);

/**
 * @param {object} deps
 * @param {typeof Electron.Tray} deps.Tray
 * @param {typeof Electron.Menu} deps.Menu
 * @param {Electron.NativeImage} deps.image  the tray image (see tray-icon.js)
 * @param {(key: string, params?: object) => string} deps.t  label resolver
 * @param {() => {tunnels: Array, total: number, active: number}} deps.getStatus
 * @param {object} deps.actions  { showWindow, armAll, disarmAll, arm, disarm,
 *        openSettings, copyDiagnostics, quit }
 */
function createTray({ Tray, Menu, image, t, getStatus, actions }) {
  const a = actions || {};
  const tray = new Tray(image);

  // Left-click shows/focuses the window (the natural gesture on Win/Linux; on
  // macOS a click opens the menu, but honouring it too is harmless).
  tray.on("click", () => a.showWindow?.());

  function stateLabel(state) {
    return t(`state.${state}`);
  }

  function tunnelItem(tunnel) {
    const live = LIVE_STATES.has(tunnel.state);
    return {
      label: `${tunnel.name || t("def.unnamed")} — ${stateLabel(tunnel.state)}`,
      submenu: [
        {
          label: t("mon.arm"),
          enabled: !live,
          click: () => a.arm?.(tunnel.id),
        },
        {
          label: t("mon.disarm"),
          enabled: live,
          click: () => a.disarm?.(tunnel.id),
        },
      ],
    };
  }

  function build() {
    const status = getStatus?.() || { tunnels: [], total: 0, active: 0 };
    const { tunnels, total, active } = status;

    const tunnelSection =
      tunnels.length === 0
        ? [{ label: t("def.list.empty"), enabled: false }]
        : tunnels.map(tunnelItem);

    const menu = Menu.buildFromTemplate([
      { label: t("tray.show"), click: () => a.showWindow?.() },
      { type: "separator" },
      { label: t("tray.tunnels"), enabled: false },
      ...tunnelSection,
      { type: "separator" },
      {
        label: t("tray.armAll"),
        enabled: total > active,
        click: () => a.armAll?.(),
      },
      {
        label: t("tray.disarmAll"),
        enabled: active > 0,
        click: () => a.disarmAll?.(),
      },
      { type: "separator" },
      { label: t("tray.settings"), click: () => a.openSettings?.() },
      { label: t("tray.copyDiagnostics"), click: () => a.copyDiagnostics?.() },
      { type: "separator" },
      { label: t("tray.quit"), click: () => a.quit?.() },
    ]);

    tray.setToolTip(
      total === 0
        ? t("tray.tooltip.none")
        : t("tray.tooltip", { active, total }),
    );
    tray.setContextMenu(menu);
  }

  build();

  return {
    /** Rebuild the menu + tooltip from the latest status. */
    update: build,
    /** Tear the tray down (app quit). */
    destroy() {
      try {
        tray.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

module.exports = { createTray };
