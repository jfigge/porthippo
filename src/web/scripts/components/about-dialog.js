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

// about-dialog.js — the in-app "About Port Hippo" modal, mirroring Rest Hippo's
// AboutDialog. An in-app PopupManager modal (not a native BrowserWindow), so it
// matches the app's other dialogs. Opened from the top-left brand mark and the
// Help ▸ About / macOS app menu (via the porthippo:show-about event). A branded
// card: logo, name (with an (i) toggle revealing version / platform / Electron),
// subtitle, description, credit, and Close.
//
// Build metadata comes from the main process over the window.porthippo bridge —
// the async getVersion() plus the static platform / arch / electron fields.
// PopupManager owns the overlay, the Escape key, and mask-click dismissal.

import { PopupManager } from "../popup-manager.js";
import { t } from "../i18n.js";
import { escapeHtml } from "../dom.js";

export class AboutDialog {
  #el;

  /** Build and open the About dialog over the shared PopupManager. */
  static open() {
    PopupManager.open(new AboutDialog());
  }

  constructor() {
    this.#el = this.#build();

    this.#el
      .querySelector(".about-close")
      .addEventListener("click", () => PopupManager.close());

    // The (i) button toggles the version/build details popover.
    const infoBtn = this.#el.querySelector(".about-info-btn");
    const build = this.#el.querySelector(".about-build");
    infoBtn.addEventListener("click", () => {
      const show = build.hasAttribute("hidden");
      build.toggleAttribute("hidden", !show);
      infoBtn.setAttribute("aria-expanded", String(show));
    });

    // Fill the build metadata asynchronously (version comes over IPC).
    this.#loadInfo();
  }

  get element() {
    return this.#el;
  }

  /** Called by PopupManager when the user clicks the overlay mask. */
  onMaskClick() {
    PopupManager.close();
  }

  /** Pull version + platform metadata from the main process / bridge. */
  async #loadInfo() {
    const bridge = window.porthippo;
    let version = null;
    try {
      version = await bridge?.getVersion?.();
    } catch {
      // Leave the version as the dev-build fallback.
    }

    const row = (label, value) =>
      `<div class="about-build-row"><span class="about-build-label">${escapeHtml(
        label,
      )}</span><span class="about-build-value">${escapeHtml(value)}</span></div>`;

    const platform =
      bridge?.platform && bridge?.arch
        ? `${bridge.platform}/${bridge.arch}`
        : "—";

    this.#el.querySelector(".about-build").innerHTML =
      row(t("about.version"), version ? `v${version}` : t("about.devBuild")) +
      row(t("about.platform"), platform) +
      row(t("about.electron"), bridge?.electron || "—");
  }

  #build() {
    const el = document.createElement("div");
    el.className = "popup about-dialog";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("menu.about"));

    el.innerHTML = `
      <img class="about-logo" src="icons/256x256.png" alt="" aria-hidden="true" draggable="false" />
      <div class="about-name-row">
        <h1 class="about-name">${escapeHtml(t("about.name"))}</h1>
        <button class="about-info-btn" type="button" aria-controls="about-build"
                aria-expanded="false" aria-label="${escapeHtml(t("about.versionInfo"))}"
                title="${escapeHtml(t("about.versionInfo"))}">i</button>
        <div class="about-build" id="about-build" hidden></div>
      </div>
      <p class="about-subtitle">${escapeHtml(t("about.subtitle"))}</p>
      <p class="about-desc">${escapeHtml(t("about.description"))}</p>
      <p class="about-credit">${escapeHtml(t("about.credit"))}</p>
      <button class="about-close" type="button" data-autofocus>${escapeHtml(t("common.close"))}</button>
    `;
    return el;
  }
}
