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

// app.js — renderer bootstrap. Wires the Definition / Monitoring view
// toggle (persisting the choice in settings), mounts the Feature 40 Definition
// view, installs the app-wide SSH host-key trust prompt, and shows the app
// version fetched over window.porthippo. The Monitoring pane is filled in by
// Feature 50.

// Activate the Feature 30 stats seam: importing it for its side effect starts the
// `porthippo:stats` subscription so the latest per-tunnel snapshots are captured
// from load, ready for the Feature 50 Monitoring view to render.
import "./stats-store.js";

import { DefinitionView } from "./components/definition-view.js";
import { MonitoringView } from "./components/monitoring-view.js";
import { HostKeyPrompt } from "./host-key-prompt.js";
import { UpdateNotifier } from "./update-notifier.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { AboutDialog } from "./components/about-dialog.js";
import { init as initI18n, t } from "./i18n.js";

const VIEWS = ["definition", "monitoring"];

// The two panes are each mounted once and kept alive across view switches — so
// the Monitoring view holds a single `porthippo:stats` subscription whichever
// view is active. `applyView` only toggles visibility.
let definitionView = null;
let monitoringView = null;
let settingsPopup = null;

function applyView(view) {
  const content = document.getElementById("app-content");
  const definition = document.getElementById("definition-view");
  const monitoring = document.getElementById("monitoring-view");
  if (!content || !definition || !monitoring) return;

  content.dataset.view = view;

  // Show only the active pane.
  definition.hidden = view === "monitoring";
  monitoring.hidden = view === "definition";

  for (const btn of document.querySelectorAll(".view-toggle-btn")) {
    btn.classList.toggle("view-toggle-btn--active", btn.dataset.view === view);
    btn.setAttribute("aria-selected", String(btn.dataset.view === view));
  }

  // App-wide notification so later panes can react (e.g. start/stop live
  // subscriptions when they become visible).
  window.dispatchEvent(
    new CustomEvent("porthippo:view-changed", { detail: { view } }),
  );
}

function initViewToggle() {
  const toggle = document.getElementById("view-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (event) => {
    const btn = event.target.closest(".view-toggle-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    if (!VIEWS.includes(view)) return;
    applyView(view);
    // Persist the choice; non-fatal if the write fails.
    window.porthippo?.settings?.set?.({ viewMode: view })?.catch?.(() => {});
  });
}

// Apply the chosen theme (Feature 60). "light"/"dark" force a palette via the
// data-theme attribute (which wins over the OS preference in theme.css);
// "system" (or unset) removes it so the OS preference applies.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

async function initDefinitionView() {
  const host = document.getElementById("definition-view");
  if (!host) return;
  definitionView = new DefinitionView();
  host.appendChild(definitionView.element);
  try {
    await definitionView.load();
  } catch (err) {
    console.error("[app] definition view load failed:", err && err.message);
  }
}

async function initMonitoringView() {
  const host = document.getElementById("monitoring-view");
  if (!host) return;
  monitoringView = new MonitoringView();
  host.appendChild(monitoringView.element);
  try {
    await monitoringView.load();
  } catch (err) {
    console.error("[app] monitoring view load failed:", err && err.message);
  }
}

// A row's "Edit" affordance in the Monitoring view asks the shell to jump to the
// Definition view for that tunnel. Stay put when already showing Definition;
// only flip away from the Monitoring view.
function initEditTunnelBridge() {
  window.addEventListener("porthippo:edit-tunnel", (event) => {
    const id = event.detail && event.detail.id;
    if (!id) return;
    const content = document.getElementById("app-content");
    if (content && content.dataset.view === "monitoring") {
      applyView("definition");
      window.porthippo?.settings
        ?.set?.({ viewMode: "definition" })
        ?.catch?.(() => {});
    }
    definitionView?.selectById(id);
  });
}

// App-shell wiring (Feature 60): the Settings panel + the commands the native
// menu / tray dispatch to the renderer (settings, new tunnel, view switch), plus
// live theme re-apply when settings change.
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

  // The top-left brand mark opens the in-app About dialog (also reachable from
  // the Help ▸ About / macOS app menu, which arrives as porthippo:show-about).
  const brand = document.getElementById("app-brand");
  if (brand) {
    brand.setAttribute("aria-label", t("header.about"));
    brand.setAttribute("title", t("header.about"));
    brand.addEventListener("click", () => AboutDialog.open());
    brand.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        AboutDialog.open();
      }
    });
  }

  window.addEventListener("porthippo:show-about", () => AboutDialog.open());

  window.addEventListener("porthippo:new-tunnel", () => {
    const content = document.getElementById("app-content");
    if (content && content.dataset.view === "monitoring") {
      applyView("definition");
      window.porthippo?.settings
        ?.set?.({ viewMode: "definition" })
        ?.catch?.(() => {});
    }
    definitionView?.createNew();
  });

  window.addEventListener("porthippo:set-view", (event) => {
    const view = event.detail;
    if (!VIEWS.includes(view)) return;
    applyView(view);
    window.porthippo?.settings?.set?.({ viewMode: view })?.catch?.(() => {});
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

  // One settings read drives the pre-paint theme + view restore.
  let settings = {};
  try {
    settings = (await window.porthippo?.settings?.get?.()) || {};
  } catch {
    // Non-fatal: fall back to defaults.
  }
  applyTheme(settings.theme);

  initViewToggle();
  applyView(
    VIEWS.includes(settings.viewMode) ? settings.viewMode : "definition",
  );
  new HostKeyPrompt().install();
  new UpdateNotifier().install();
  initEditTunnelBridge();
  initShell();
  initDefinitionView();
  initMonitoringView();
});
