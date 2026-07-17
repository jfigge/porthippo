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

// dialog.js — the shared chrome for the Feature 45 editor dialogs (tunnel /
// credential / jump host). Each is a native `<dialog>` opened with showModal(),
// which gives real top-layer STACKING for free: a credential picker's "New…"
// opens the credential editor ON TOP of the tunnel editor with no custom z-index
// or focus-trap code. (PopupManager stays the seam for lightweight confirm/notify
// prompts, which never stack.)
//
// This class owns only the frame — header title, a body the caller fills, an
// error banner, and a Cancel/Save footer wired to `onCancel` / `onSubmit`. It
// makes no assumptions about the fields inside; each editor composes one and
// drives validation + persistence in its own onSubmit.

import { el } from "./dom.js";
import { t } from "./i18n.js";

export class Dialog {
  #el;
  #titleEl;
  #bodyEl;
  #bannerEl;
  #saveBtn;
  #footerStartEl;
  #onSubmit;
  #onCancel;
  #submitting = false;
  // Optional tabs: a pinned nav strip outside the scrolling body, each tab a panel
  // the caller fills via `tabBody(id)`. Empty → a single body (existing editors).
  #tabButtons = new Map();
  #panels = new Map();
  #defaultTab = null;

  /**
   * @param {object} opts
   * @param {string} [opts.className]   extra class on the <dialog>
   * @param {string} [opts.title]
   * @param {string} [opts.saveLabel]   footer submit label (default "Save")
   * @param {Array<{id:string,label:string}>} [opts.tabs]  when given, the body is
   *        split into one panel per tab behind a pinned tab strip; fill each with
   *        `tabBody(id)` and switch with `showTab(id)`.
   * @param {() => void} [opts.onSubmit] the form submitted (Enter / Save)
   * @param {() => void} [opts.onCancel] Cancel / Escape
   */
  constructor({
    className = "",
    title = "",
    saveLabel,
    tabs,
    onSubmit,
    onCancel,
  } = {}) {
    this.#onSubmit = onSubmit;
    this.#onCancel = onCancel;

    this.#titleEl = el("h2", { class: "dialog-title", text: title });
    this.#bodyEl = el("div", { class: "dialog-body" });
    this.#bannerEl = el("p", {
      class: "dialog-error",
      hidden: true,
      role: "alert",
    });

    // Build the tab strip + panels when tabs are given. The nav is pinned outside
    // the body so it stays put while the active panel scrolls.
    let navEl = null;
    if (Array.isArray(tabs) && tabs.length) {
      navEl = el(
        "div",
        { class: "dialog-tabs", role: "tablist" },
        tabs.map((tb) => {
          const btn = el("button", {
            class: "dialog-tab",
            type: "button",
            role: "tab",
            text: tb.label,
            "aria-selected": "false",
            dataset: { tab: tb.id },
            onClick: () => this.showTab(tb.id),
          });
          this.#tabButtons.set(tb.id, btn);
          return btn;
        }),
      );
      for (const tb of tabs) {
        const panel = el("div", {
          class: "dialog-tab-panel",
          role: "tabpanel",
          dataset: { tab: tb.id },
          hidden: true,
        });
        this.#panels.set(tb.id, panel);
        this.#bodyEl.append(panel);
      }
      this.#defaultTab = tabs[0].id;
    }

    this.#saveBtn = el("button", {
      class: "btn btn--primary dialog-save",
      type: "submit",
      text: saveLabel || t("common.save"),
    });
    // A left-aligned slot for extra footer actions (e.g. the tunnel editor's
    // "Test resolution"); it pushes Cancel/Save to the right. Empty by default.
    this.#footerStartEl = el("div", { class: "dialog-footer-start" });

    const form = el(
      "form",
      {
        class: "dialog-form",
        onSubmit: (e) => {
          e.preventDefault();
          this.#submit();
        },
      },
      [
        ...(navEl ? [navEl] : []),
        this.#bodyEl,
        this.#bannerEl,
        el("div", { class: "dialog-footer" }, [
          this.#footerStartEl,
          el("button", {
            class: "btn btn--secondary dialog-cancel",
            type: "button",
            text: t("common.cancel"),
            onClick: () => this.#cancel(),
          }),
          this.#saveBtn,
        ]),
      ],
    );

    this.#el = el("dialog", { class: `editor-dialog ${className}`.trim() }, [
      el("div", { class: "dialog-header" }, [this.#titleEl]),
      form,
    ]);

    if (this.#defaultTab) this.showTab(this.#defaultTab);

    // Escape fires the native `cancel` event (which would also close the dialog);
    // we take it over so cleanup + the onCancel callback run exactly once.
    this.#el.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.#cancel();
    });
  }

  /** The `<dialog>` element. */
  get element() {
    return this.#el;
  }

  /** The body container the composing editor fills with fields. */
  get body() {
    return this.#bodyEl;
  }

  /** The left-aligned footer slot for extra actions (Cancel/Save stay right). */
  get footerStart() {
    return this.#footerStartEl;
  }

  /**
   * The panel container for a tab (when built with `tabs`); falls back to the whole
   * body so a non-tabbed caller is unaffected.
   * @param {string} id
   * @returns {HTMLElement}
   */
  tabBody(id) {
    return this.#panels.get(id) || this.#bodyEl;
  }

  /** Reveal a tab's panel and mark its nav button active (no-op if untabbed). */
  showTab(id) {
    if (!this.#panels.has(id)) return;
    for (const [tid, panel] of this.#panels) panel.hidden = tid !== id;
    for (const [tid, btn] of this.#tabButtons) {
      const on = tid === id;
      btn.classList.toggle("dialog-tab--active", on);
      btn.setAttribute("aria-selected", String(on));
    }
  }

  /** Update the header title (e.g. New vs Edit). */
  setTitle(title) {
    this.#titleEl.textContent = title;
  }

  /** Show as a modal (mounting into <body> on first open), focus the first field. */
  open() {
    if (!this.#el.isConnected) document.body.appendChild(this.#el);
    this.clearError();
    if (this.#defaultTab) this.showTab(this.#defaultTab); // always open on tab 1
    this.#el.showModal();
    const focusTarget =
      this.#bodyEl.querySelector("[data-autofocus]") ||
      this.#bodyEl.querySelector("input, select, textarea");
    focusTarget?.focus();
  }

  /** Close the modal (no-op when already closed). */
  close() {
    if (this.#el.open) this.#el.close();
    this.clearError();
  }

  // Run the caller's onSubmit, guarding against double-submit: a second Enter or
  // Save-click while the first (async) save is still in flight is ignored, and the
  // Save button is disabled for the duration. Without this, a rapid double-submit
  // fires the store create/update twice and can persist duplicate records.
  async #submit() {
    if (this.#submitting || !this.#onSubmit) return;
    this.#submitting = true;
    this.#saveBtn.disabled = true;
    try {
      await this.#onSubmit();
    } finally {
      this.#submitting = false;
      this.#saveBtn.disabled = false;
    }
  }

  #cancel() {
    if (this.#onCancel) this.#onCancel();
    else this.close();
  }

  /** Show an error banner above the footer (e.g. a failed store write). */
  showError(message) {
    this.#bannerEl.textContent = message;
    this.#bannerEl.hidden = false;
  }

  /** Clear the error banner. */
  clearError() {
    this.#bannerEl.textContent = "";
    this.#bannerEl.hidden = true;
  }
}
