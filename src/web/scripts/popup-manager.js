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
  active: null, // { popup, dialogEl } currently shown, or null
  queue: [], // popups waiting behind the active one — QUEUED, never dropped
};

function dismiss(popup) {
  (popup.onMaskClick || PopupManager.close)();
}

// Mount a popup as a native modal <dialog>. showModal() puts it in the browser
// TOP LAYER, so a popup raised while an editor <dialog> is open stacks ABOVE it
// (the old plain-overlay popup was occluded by any open editor dialog and left
// inert). Escape → native `cancel`; a click landing on the dialog itself (not its
// content) is a backdrop click.
function mount(popup) {
  const dialogEl = el("dialog", { class: "popup-dialog" }, [popup.element]);
  dialogEl.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss(popup);
  });
  dialogEl.addEventListener("click", (event) => {
    if (event.target === dialogEl) dismiss(popup);
  });
  document.body.appendChild(dialogEl);
  state.active = { popup, dialogEl };
  dialogEl.showModal();

  const focusTarget =
    popup.element.querySelector("[data-autofocus]") ||
    popup.element.querySelector("button");
  focusTarget?.focus();
}

export const PopupManager = {
  /**
   * Mount a popup. If one is already open the new popup is QUEUED (shown when the
   * current one closes) rather than replacing it — so a second host-key prompt
   * can't silently strand the first's pending SSH connection. Focuses the first
   * `[data-autofocus]` control, or the first button, so Enter/Escape work at once.
   * @param {{ element: HTMLElement, onMaskClick?: () => void }} popup
   */
  open(popup) {
    if (!popup || !popup.element) return;
    // Defensive: a detached active dialog means the previous popup is gone (e.g.
    // the DOM was reset under tests) — treat the host as idle, don't queue behind
    // a ghost.
    if (state.active && !state.active.dialogEl.isConnected) {
      state.active = null;
      state.queue = [];
    }
    if (state.active) {
      state.queue.push(popup);
      return;
    }
    mount(popup);
  },

  /** Close the active popup, then show the next queued one. Safe to call idle. */
  close() {
    const active = state.active;
    state.active = null;
    if (active) {
      try {
        active.dialogEl.close();
      } catch {
        // already closed
      }
      active.dialogEl.remove();
    }
    const next = state.queue.shift();
    if (next) mount(next);
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
