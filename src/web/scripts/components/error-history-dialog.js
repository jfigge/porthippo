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

// error-history-dialog.js — builds the popup body listing a tunnel's error (and,
// later, warning) history, newest first. A pure DOM builder: it takes the event
// log (as returned by `window.porthippo.tunnels.events(id)`) and returns a
// `.popup` element for PopupManager.open — no IPC, no singleton, so it's directly
// unit-testable. Each event is `{ at, level, message }`; `level` styles the row
// and picks its label so a future "warning" entry slots in with no new wiring.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { formatRelativeTime } from "../utils/format.js";

function eventRow(event, now) {
  const level = event && event.level === "warning" ? "warning" : "error";
  return el(
    "div",
    { class: `error-history-item error-history-item--${level}` },
    [
      el("div", { class: "error-history-meta" }, [
        el("span", {
          class: `error-history-level error-history-level--${level}`,
          text: t(`errors.level.${level}`),
        }),
        el("span", {
          class: "error-history-time",
          text: formatRelativeTime(event && event.at, now),
        }),
      ]),
      el("p", {
        class: "error-history-message",
        text: (event && event.message) || "",
      }),
    ],
  );
}

/**
 * Build the error-history popup element.
 *
 * @param {object} opts
 * @param {Array<{at:number, level:string, message:string}>} [opts.events]  oldest first
 * @param {string} opts.title
 * @param {() => number} [opts.now]  clock for relative timestamps
 * @param {() => void} [opts.onClose]  fired by the Close button
 * @returns {HTMLElement}  a `.popup` for PopupManager.open
 */
export function buildErrorHistory({
  events = [],
  title,
  now = Date.now,
  onClose,
} = {}) {
  const list = Array.isArray(events) ? events : [];
  const at = now();

  const body =
    list.length === 0
      ? el("p", { class: "popup-message", text: t("errors.dialog.empty") })
      : el(
          "div",
          { class: "error-history-list" },
          // Newest first — the log is stored oldest-first.
          [...list].reverse().map((e) => eventRow(e, at)),
        );

  const closeBtn = el("button", {
    class: "btn popup-btn btn--primary",
    type: "button",
    text: t("common.close"),
    onClick: () => onClose?.(),
    "data-autofocus": true,
  });

  return el(
    "div",
    {
      class: "popup popup-error-history",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": title || "",
    },
    [
      el("div", { class: "popup-header" }, [
        el("span", { class: "popup-title", text: title || "" }),
      ]),
      el("div", { class: "popup-body" }, [body]),
      el("div", { class: "popup-footer" }, [closeBtn]),
    ],
  );
}
