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
 * @param {Electron.NativeImage} deps.image  the initial tray image (see tray-icon.js)
 * @param {(status: object) => Electron.NativeImage} [deps.renderImage]  builds the
 *        tray image from the current status, so the badge tracks the connected
 *        count; omitted → the initial image is kept for the tray's lifetime.
 * @param {(key: string, params?: object) => string} deps.t  label resolver
 * @param {() => {tunnels: Array, total: number, active: number}} deps.getStatus
 * @param {object} deps.actions  { showWindow, armAll, disarmAll, arm, disarm,
 *        openSettings, copyDiagnostics, quit }
 */
function createTray({ Tray, Menu, image, renderImage, t, getStatus, actions }) {
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

  // A group submenu (Feature 140): arm-all is offered while any member is still
  // down, disarm-all while any is up — mirroring the fleet-wide items below.
  function groupItem(group) {
    const total = group.total || 0;
    const armed = group.armed || 0;
    return {
      label: group.name || t("def.unnamed"),
      submenu: [
        {
          label: t("tray.group.armAll"),
          enabled: total > armed,
          click: () => a.armGroup?.(group.id),
        },
        {
          label: t("tray.group.disarmAll"),
          enabled: armed > 0,
          click: () => a.disarmGroup?.(group.id),
        },
      ],
    };
  }

  // The aggregate-health summary line (Feature 130), shown only when the fleet
  // isn't fully healthy so the tray stays quiet when everything is up.
  function healthItems(status) {
    if (status.health === "error") {
      return [
        {
          label: t("tray.health.error", { n: status.errored || 0 }),
          enabled: false,
        },
        { type: "separator" },
      ];
    }
    if (status.health === "reconnecting") {
      return [
        {
          label: t("tray.health.reconnecting", { n: status.reconnecting || 0 }),
          enabled: false,
        },
        { type: "separator" },
      ];
    }
    return [];
  }

  function build() {
    const status = getStatus?.() || {
      tunnels: [],
      total: 0,
      active: 0,
      connected: 0,
    };
    const { tunnels, total, active } = status;

    // Refresh the icon so its badge reflects the latest count / health rollup.
    if (renderImage) {
      try {
        tray.setImage(renderImage(status));
      } catch {
        // Keep the current image if rebuilding it fails.
      }
    }

    const tunnelSection =
      tunnels.length === 0
        ? [{ label: t("def.list.empty"), enabled: false }]
        : tunnels.map(tunnelItem);

    // Per-group arm-all / disarm-all (Feature 140), shown only when groups exist.
    const groups = Array.isArray(status.groups) ? status.groups : [];
    const groupSection = groups.length
      ? [
          { type: "separator" },
          { label: t("tray.groups"), enabled: false },
          ...groups.map(groupItem),
        ]
      : [];

    const menu = Menu.buildFromTemplate([
      { label: t("tray.show"), click: () => a.showWindow?.() },
      { type: "separator" },
      ...healthItems(status),
      { label: t("tray.tunnels"), enabled: false },
      ...tunnelSection,
      ...groupSection,
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

module.exports = { createTray, LIVE_STATES };
