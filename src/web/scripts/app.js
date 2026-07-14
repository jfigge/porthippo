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

// app.js — renderer bootstrap. Mounts the single master-detail TunnelsView
// (sidebar list + live detail), installs the app-wide SSH host-key trust prompt +
// update notifier, wires the Settings/About shell, and applies the chosen theme.

// Activate the stats seam: importing it for its side effect starts the
// `porthippo:stats` subscription so snapshots are captured from load.
import "./stats-store.js";

import { TunnelsView } from "./components/tunnels-view.js";
import { HostKeyPrompt } from "./host-key-prompt.js";
import { UpdateNotifier } from "./update-notifier.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { AboutDialog } from "./components/about-dialog.js";
import { init as initI18n, t } from "./i18n.js";

let tunnelsView = null;
let settingsPopup = null;

// Apply the chosen theme (Feature 60). "light"/"dark" force a palette via the
// data-theme attribute (which wins over the OS preference in theme.css);
// "system" (or unset) removes it so the OS preference applies.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

async function initTunnelsView() {
  const host = document.getElementById("tunnels-view");
  if (!host) return;
  tunnelsView = new TunnelsView();
  host.appendChild(tunnelsView.element);
  try {
    await tunnelsView.load();
  } catch (err) {
    console.error("[app] tunnels view load failed:", err && err.message);
  }
}

// App-shell wiring (Feature 60): the Settings panel + the commands the native
// menu / tray dispatch to the renderer (settings, new tunnel), plus live theme
// re-apply when settings change.
function initShell() {
  settingsPopup = new SettingsPopup();

  const settingsBtn = document.getElementById("settings-btn");
  if (settingsBtn) {
    settingsBtn.setAttribute("aria-label", t("header.settings"));
    settingsBtn.setAttribute("title", t("header.settings"));
    settingsBtn.addEventListener("click", () => settingsPopup.open());
  }

  window.addEventListener("porthippo:open-settings", () =>
    settingsPopup.open(),
  );

  // The header view-mode selector (cards ↔ list). It's the control; TunnelsView
  // owns the state, so a change is broadcast to it and it echoes the resolved
  // mode back (incl. on load from settings) to keep the <select> in sync.
  const viewMode = document.getElementById("view-mode");
  if (viewMode) {
    viewMode.setAttribute("aria-label", t("view.mode.label"));
    viewMode.options[0].textContent = t("view.mode.cards");
    viewMode.options[1].textContent = t("view.mode.list");
    viewMode.addEventListener("change", () => {
      window.dispatchEvent(
        new CustomEvent("porthippo:set-detail-mode", {
          detail: { mode: viewMode.value },
        }),
      );
    });
    window.addEventListener("porthippo:detail-mode-changed", (event) => {
      const mode = event.detail && event.detail.mode;
      if (mode) viewMode.value = mode;
    });
  }

  // The top-left brand ICON button opens the in-app About dialog (also reachable
  // from the Help ▸ About / macOS app menu, which arrives as porthippo:show-about).
  // It's a native <button>, so Enter/Space activation is handled for us; the logo
  // + subtitle text beside it are intentionally not clickable.
  const brand = document.getElementById("app-brand");
  if (brand) {
    brand.setAttribute("aria-label", t("header.about"));
    brand.setAttribute("title", t("header.about"));
    brand.addEventListener("click", () => AboutDialog.open());
  }

  window.addEventListener("porthippo:show-about", () => AboutDialog.open());

  // "New Tunnel" from the native menu / tray opens the editor.
  window.addEventListener("porthippo:new-tunnel", () =>
    tunnelsView?.createNew(),
  );

  // "Edit" affordances (e.g. from the tray) select the tunnel in the detail view.
  window.addEventListener("porthippo:edit-tunnel", (event) => {
    const id = event.detail && event.detail.id;
    if (id) tunnelsView?.selectById(id);
  });

  // A settings change re-applies the theme live (other prefs are read on demand
  // by their consumers; language triggers a full reload from the popup itself).
  window.addEventListener("porthippo:settings-changed", (event) => {
    if (event.detail && event.detail.theme !== undefined) {
      applyTheme(event.detail.theme);
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  // Load the active locale's catalog before the first render so every string
  // resolves correctly (English is embedded, so this only matters once other
  // locales ship — but awaiting it keeps the ordering guarantee).
  await initI18n();

  // One settings read drives the pre-paint theme.
  let settings = {};
  try {
    settings = (await window.porthippo?.settings?.get?.()) || {};
  } catch {
    // Non-fatal: fall back to defaults.
  }
  applyTheme(settings.theme);

  new HostKeyPrompt().install();
  new UpdateNotifier().install();
  initShell();
  initTunnelsView();
});
