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

// host-keys-panel.js — the Settings → Host Keys tab body: the SSH host-key
// fingerprints the user has accepted through Port Hippo (TOFU, stored in
// known-hosts.json). Two operations only — see the list, and forget an entry.
//
// Forgetting a key removes the stored trust so the NEXT connection to that host
// re-prompts as a fresh TOFU; it is also the only way to recover from a legitimate
// host-key rotation (a *changed* key is a hard reject with no in-place re-trust).
//
// Split out of settings-popup.js and shaped like its sibling settings-security.js:
// it builds a full `.settings-panel[data-panel="hostkeys"]` section in the
// constructor, exposes it via `element`, and the popup calls `load()` each time the
// tab is revealed. It pulls the list over `window.porthippo.hostkeys.list()` and
// only ever displays fingerprints — no key material or secret is involved. Because
// PopupManager hosts exactly one popup, the forget confirmation is an inline
// per-row swap, never a nested dialog that would detach Settings.

import { el, clear } from "../dom.js";
import { t, formatDate } from "../i18n.js";

export class HostKeysPanel {
  #porthippo;
  #root;
  #listRegion;

  constructor({ porthippo } = {}) {
    this.#porthippo =
      porthippo ||
      (typeof window !== "undefined" ? window.porthippo : undefined);
    this.#listRegion = el("div", { class: "hostkeys-list-region" });
    this.#root = el(
      "section",
      { class: "settings-panel", dataset: { panel: "hostkeys" }, hidden: true },
      [
        el("h3", {
          class: "settings-subhead",
          text: t("settings.hostkeys.heading"),
        }),
        el("p", { class: "settings-help", text: t("settings.hostkeys.help") }),
        this.#listRegion,
      ],
    );
  }

  /** The `.settings-panel[data-panel="hostkeys"]` section the popup mounts. */
  get element() {
    return this.#root;
  }

  /**
   * Pull the accepted-key list from main and render it. Safe to call repeatedly
   * (the Settings popup calls it each time the tab is revealed), so it reflects
   * TOFU acceptances made since the popup was opened. Never throws.
   */
  async load() {
    let entries = [];
    try {
      entries = (await this.#porthippo?.hostkeys?.list?.()) || [];
    } catch {
      entries = []; // a read failure shows the empty state rather than erroring
    }
    // Alphabetical by host:port for a stable inventory.
    this.#render(
      [...entries].sort((a, b) => a.hostPort.localeCompare(b.hostPort)),
    );
  }

  #render(entries) {
    clear(this.#listRegion);
    if (entries.length === 0) {
      this.#listRegion.append(
        el("p", {
          class: "hostkeys-empty",
          text: t("settings.hostkeys.empty"),
        }),
      );
      return;
    }
    this.#listRegion.append(
      el(
        "div",
        { class: "hostkeys-list", role: "list" },
        entries.map((entry) => this.#row(entry)),
      ),
    );
  }

  // One accepted host: identity + fingerprint on the left, added-date + the
  // forget action on the right. The action cell swaps between button and inline
  // confirm in place (single-popup rule — no nested dialog).
  #row(entry) {
    const actions = el("div", { class: "hostkeys-actions" });
    const item = el("div", { class: "hostkeys-item", role: "listitem" }, [
      el("div", { class: "hostkeys-info" }, [
        el("div", { class: "hostkeys-host", text: entry.hostPort }),
        el("div", { class: "hostkeys-fingerprint", text: entry.fingerprint }),
      ]),
      el("div", { class: "hostkeys-meta" }, [
        el("span", {
          class: "hostkeys-added",
          text: t("settings.hostkeys.added", {
            date: formatDate(entry.addedAt),
          }),
        }),
        actions,
      ]),
    ]);
    this.#showForgetButton(actions, item, entry.hostPort);
    return item;
  }

  #showForgetButton(actions, item, hostPort) {
    item.classList.remove("hostkeys-item--confirming");
    clear(actions).append(
      el("button", {
        class: "btn btn--secondary hostkeys-forget",
        type: "button",
        text: t("settings.hostkeys.forget"),
        "aria-label": t("settings.hostkeys.forgetAria", { host: hostPort }),
        onClick: () => this.#showForgetConfirm(actions, item, hostPort),
      }),
    );
  }

  #showForgetConfirm(actions, item, hostPort) {
    item.classList.add("hostkeys-item--confirming");
    clear(actions).append(
      el("span", {
        class: "hostkeys-confirm-label",
        text: t("settings.hostkeys.confirm"),
      }),
      el("button", {
        class: "btn btn--ghost hostkeys-confirm-cancel",
        type: "button",
        text: t("common.cancel"),
        onClick: () => this.#showForgetButton(actions, item, hostPort),
      }),
      el("button", {
        class: "btn btn--danger hostkeys-confirm-forget",
        type: "button",
        text: t("settings.hostkeys.forget"),
        onClick: () => this.#forget(hostPort),
      }),
    );
  }

  async #forget(hostPort) {
    let res;
    try {
      res = await this.#porthippo?.hostkeys?.revoke?.(hostPort);
    } catch {
      res = { __hippoError: true };
    }
    // Re-pull on success (the row disappears); leave the list untouched on a write
    // failure so the entry — and its forget button — remain for a retry.
    if (!res || !res.__hippoError) this.load();
  }
}
