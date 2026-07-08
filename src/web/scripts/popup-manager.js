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

// popup-manager.js — a single shared modal host, mirroring Rest Hippo's
// PopupManager. One overlay mask, one active popup at a time. A "popup" is any
// object of shape `{ element: HTMLElement, onMaskClick?: () => void }`. The
// `confirm` / `confirmDelete` / `notify` helpers build the standard dialog
// skeleton (`.popup` → header / body / footer) so callers don't repeat it.
//
// This is the only app-wide dialog seam in the renderer; the Definition view uses
// it for delete confirmations and the SSH host-key trust prompt.

import { el } from "./dom.js";
import { t } from "./i18n.js";

const state = {
  overlay: null, // the mask element (lazily created, lives on <body>)
  active: null, // the current popup object, or null
  onKeyDown: null, // the Escape handler currently installed
};

function ensureOverlay() {
  if (state.overlay) return state.overlay;
  const overlay = el("div", {
    class: "popup-overlay",
    onClick: (event) => {
      // Only a click on the mask itself (not inside the popup) dismisses.
      if (event.target === overlay && state.active) {
        (state.active.onMaskClick || PopupManager.close)();
      }
    },
  });
  document.body.appendChild(overlay);
  state.overlay = overlay;
  return overlay;
}

export const PopupManager = {
  /**
   * Mount a popup. Any currently-open popup is closed first. Focuses the first
   * `[data-autofocus]` control, or the first button, so Enter/Escape work at once.
   * @param {{ element: HTMLElement, onMaskClick?: () => void }} popup
   */
  open(popup) {
    if (!popup || !popup.element) return;
    if (state.active) this.close();

    const overlay = ensureOverlay();
    overlay.appendChild(popup.element);
    overlay.classList.add("popup-overlay--visible");
    state.active = popup;

    state.onKeyDown = (event) => {
      if (event.key === "Escape" && state.active) {
        event.preventDefault();
        (state.active.onMaskClick || PopupManager.close)();
      }
    };
    document.addEventListener("keydown", state.onKeyDown);

    const focusTarget =
      popup.element.querySelector("[data-autofocus]") ||
      popup.element.querySelector("button");
    focusTarget?.focus();
  },

  /** Tear down the active popup and hide the mask. Safe to call when idle. */
  close() {
    if (state.onKeyDown) {
      document.removeEventListener("keydown", state.onKeyDown);
      state.onKeyDown = null;
    }
    if (state.overlay) {
      state.overlay.classList.remove("popup-overlay--visible");
      while (state.overlay.firstChild) {
        state.overlay.removeChild(state.overlay.firstChild);
      }
    }
    state.active = null;
  },

  /**
   * A two-button confirmation dialog. `onConfirm` / `onCancel` fire after the
   * dialog closes. `confirmClass` styles the confirm button (e.g. "btn--danger").
   * @param {object} opts
   */
  confirm({
    title,
    message,
    note,
    confirmLabel,
    cancelLabel,
    confirmClass = "btn--primary",
    onConfirm,
    onCancel,
  } = {}) {
    const done = (fn) => () => {
      this.close();
      fn?.();
    };

    const confirmBtn = el("button", {
      class: `btn popup-btn ${confirmClass}`,
      type: "button",
      text: confirmLabel || t("common.confirm"),
      onClick: done(onConfirm),
      "data-autofocus": true,
    });
    const cancelBtn = el("button", {
      class: "btn popup-btn btn--secondary",
      type: "button",
      text: cancelLabel || t("common.cancel"),
      onClick: done(onCancel),
    });

    const element = el(
      "div",
      {
        class: "popup popup-confirm",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title || message || "",
      },
      [
        title &&
          el("div", { class: "popup-header" }, [
            el("span", { class: "popup-title", text: title }),
          ]),
        el(
          "div",
          { class: "popup-body" },
          [
            message && el("p", { class: "popup-message", text: message }),
            note && el("p", { class: "popup-note", text: note }),
          ].filter(Boolean),
        ),
        el("div", { class: "popup-footer" }, [cancelBtn, confirmBtn]),
      ].filter(Boolean),
    );

    this.open({ element, onMaskClick: done(onCancel) });
  },

  /** A destructive-action confirm preset (danger button, Delete label). */
  confirmDelete({ title, message, onConfirm, onCancel } = {}) {
    this.confirm({
      title: title || t("def.delete.title"),
      message,
      confirmLabel: t("common.delete"),
      confirmClass: "btn--danger",
      onConfirm,
      onCancel,
    });
  },

  /**
   * A single-button acknowledgement dialog (no cancel). Used for the host-key
   * "changed" warning, where there's nothing to accept — only to dismiss.
   * @param {object} opts
   */
  notify({ title, message, okLabel, okClass = "btn--primary", onClose } = {}) {
    const okBtn = el("button", {
      class: `btn popup-btn ${okClass}`,
      type: "button",
      text: okLabel || t("common.dismiss"),
      onClick: () => {
        this.close();
        onClose?.();
      },
      "data-autofocus": true,
    });

    const element = el(
      "div",
      {
        class: "popup popup-notify",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-label": title || message || "",
      },
      [
        title &&
          el("div", { class: "popup-header" }, [
            el("span", { class: "popup-title", text: title }),
          ]),
        el("div", { class: "popup-body" }, [
          message && el("p", { class: "popup-message", text: message }),
        ]),
        el("div", { class: "popup-footer" }, [okBtn]),
      ].filter(Boolean),
    );

    this.open({
      element,
      onMaskClick: () => {
        this.close();
        onClose?.();
      },
    });
  },
};
