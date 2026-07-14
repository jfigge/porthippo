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
import { UnlockPrompt } from "./unlock-prompt.js";
import { UpdateNotifier } from "./update-notifier.js";
import { SettingsPopup } from "./components/settings-popup.js";
import { AboutDialog } from "./components/about-dialog.js";
import { init as initI18n, t } from "./i18n.js";
import { icons } from "./icons.js";
import {
  installZoomHandlers,
  FONT_SIZES,
  DEFAULT_FONT_SIZE,
} from "./zoom-handlers.js";

let tunnelsView = null;
let settingsPopup = null;

// UI typeface stacks keyed by the fontFamily setting. Only Inter is bundled
// (src/web/fonts/); the rest resolve to platform/system faces. Mirrors Rest Hippo.
const FONT_STACKS = {
  inter: '"Inter", "Segoe UI", system-ui, -apple-system, sans-serif',
  system:
    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "sf-pro": '-apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif',
  segoe: '"Segoe UI", system-ui, sans-serif',
  ubuntu: '"Ubuntu", "Cantarell", system-ui, sans-serif',
  roboto: '"Roboto", "Helvetica Neue", system-ui, sans-serif',
};

// The live UI font size (px); the zoom factor is fontSize / DEFAULT_FONT_SIZE.
let currentFontSize = DEFAULT_FONT_SIZE;

// Apply the chosen theme (Feature 60). "light"/"dark" force a palette via the
// data-theme attribute (which wins over the OS preference in theme.css);
// "system" (or unset) removes it so the OS preference applies.
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  else delete root.dataset.theme;
}

// Apply theme + typeface + zoom from a (possibly partial) settings object. The
// font size drives a real Chromium zoom factor (relative to the 13px baseline),
// so the whole px-authored UI scales — not just the elements using --font-size.
function applyAppearance(settings) {
  if (!settings) return;
  if (settings.theme !== undefined) applyTheme(settings.theme);
  if (settings.fontFamily !== undefined) {
    const stack = FONT_STACKS[settings.fontFamily] ?? FONT_STACKS.inter;
    document.documentElement.style.setProperty("--font-sans", stack);
  }
  if (settings.fontSize !== undefined) {
    const size = FONT_SIZES.includes(settings.fontSize)
      ? settings.fontSize
      : DEFAULT_FONT_SIZE;
    currentFontSize = size;
    window.porthippo?.setZoomFactor?.(size / DEFAULT_FONT_SIZE);
    // Keep the settings popup's dropdown in step when a zoom gesture (not the
    // popup itself) changed the size.
    settingsPopup?.syncAppearance?.({ fontSize: size });
  }
}

// Persist + apply a font size chosen by a zoom gesture or the View menu. (The
// settings popup persists through its own change handler; this is the other path.)
function commitFontSize(size) {
  if (size === currentFontSize) return;
  window.porthippo?.settings?.set?.({ fontSize: size })?.catch?.(() => {});
  applyAppearance({ fontSize: size });
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

  // The header view-mode toggle (cards ↔ list). It's the control; TunnelsView
  // owns the state, so a click broadcasts the OTHER mode and the view echoes the
  // resolved mode back (incl. on load from settings) to keep the toggle in sync.
  // The button shows the glyph + hint for the mode it switches TO: in cards view
  // it offers "Display List", in list view it offers "Display Cards".
  const viewToggle = document.getElementById("view-mode-toggle");
  if (viewToggle) {
    let currentMode = "cards";
    const renderToggle = (mode) => {
      currentMode = mode === "list" ? "list" : "cards";
      const toList = currentMode === "cards"; // clicking would switch to list
      viewToggle.innerHTML = toList ? icons.list() : icons.cards();
      const hint = toList ? t("view.mode.showList") : t("view.mode.showCards");
      viewToggle.setAttribute("aria-label", hint);
      viewToggle.setAttribute("title", hint);
    };
    renderToggle(currentMode); // sensible default until the view echoes back
    viewToggle.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("porthippo:set-detail-mode", {
          detail: { mode: currentMode === "cards" ? "list" : "cards" },
        }),
      );
    });
    window.addEventListener("porthippo:detail-mode-changed", (event) => {
      const mode = event.detail && event.detail.mode;
      if (mode) renderToggle(mode);
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

  // A settings change re-applies appearance live — theme, typeface, and zoom
  // (other prefs are read on demand by their consumers; language triggers a full
  // reload from the popup itself).
  window.addEventListener("porthippo:settings-changed", (event) => {
    applyAppearance(event.detail);
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
  applyAppearance(settings);

  new HostKeyPrompt().install();
  new UpdateNotifier().install();
  // Master-password mode boots locked — prompt to unlock for the session so the
  // deferred tunnels (held disarmed in main until unlock) can arm.
  new UnlockPrompt().install();
  initShell();
  // Cmd +/- (and Ctrl+wheel / pinch, and the View menu) step the UI zoom.
  installZoomHandlers({
    getFontSize: () => currentFontSize,
    setFontSize: (size) => commitFontSize(size),
  });
  initTunnelsView();
});
