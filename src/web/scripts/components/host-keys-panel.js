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

// host-keys-panel.js — the Settings → Host Keys tab body. It shows SSH host-key
// fingerprints under two sub-tabs:
//
//   • "Port Hippo" — the keys the user accepted through Port Hippo (TOFU, stored
//     in known-hosts.json). Manageable: see the list and forget an entry, which
//     removes the stored trust so the NEXT connection re-prompts as a fresh TOFU
//     (also the only way to recover from a legitimate host-key rotation, since a
//     *changed* key is a hard reject with no in-place re-trust).
//   • "Operating System" — the user's own ~/.ssh/known_hosts. READ-ONLY: Port
//     Hippo checks these keys but never edits that file (the OS owns it), so this
//     tab has no forget action and instead references where to manage them.
//
// Split out of settings-popup.js and shaped like its sibling settings-security.js:
// it builds a full `.settings-panel[data-panel="hostkeys"]` section in the
// constructor, exposes it via `element`, and the popup calls `load()` each time the
// tab is revealed (which refreshes whichever sub-tab is active). It only ever
// displays fingerprints — no key material or secret is involved. Because
// PopupManager hosts exactly one popup, the forget confirmation is an inline
// per-row swap, never a nested dialog that would detach Settings.

import { el, clear } from "../dom.js";
import { t, formatDate } from "../i18n.js";

export class HostKeysPanel {
  #porthippo;
  #root;
  #tabsEl;
  #body;
  #active = "porthippo"; // "porthippo" | "os"

  constructor({ porthippo } = {}) {
    this.#porthippo =
      porthippo ||
      (typeof window !== "undefined" ? window.porthippo : undefined);

    this.#tabsEl = el("div", { class: "hostkeys-tabs", role: "tablist" }, [
      this.#tabButton("porthippo", true),
      this.#tabButton("os", false),
    ]);
    this.#body = el("div", { class: "hostkeys-body" });

    this.#root = el(
      "section",
      { class: "settings-panel", dataset: { panel: "hostkeys" }, hidden: true },
      [
        el("h3", {
          class: "settings-subhead",
          text: t("settings.hostkeys.heading"),
        }),
        this.#tabsEl,
        this.#body,
      ],
    );
  }

  /** The `.settings-panel[data-panel="hostkeys"]` section the popup mounts. */
  get element() {
    return this.#root;
  }

  /**
   * (Re)load and render the active sub-tab. Safe to call repeatedly — the Settings
   * popup calls it each time the Host Keys tab is revealed, so it reflects TOFU
   * acceptances (Port Hippo tab) and known_hosts edits (OS tab) since it opened.
   * Never throws.
   */
  async load() {
    await this.#loadActive();
  }

  // ── Tabs ────────────────────────────────────────────────────────────────────

  #tabButton(name, active) {
    return el("button", {
      class: `hostkeys-tab${active ? " hostkeys-tab--active" : ""}`,
      type: "button",
      role: "tab",
      dataset: { tab: name },
      "aria-selected": String(Boolean(active)),
      text: t(`settings.hostkeys.tab.${name}`),
      onClick: () => this.#selectTab(name),
    });
  }

  #selectTab(name) {
    this.#active = name;
    for (const btn of this.#tabsEl.querySelectorAll(".hostkeys-tab")) {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("hostkeys-tab--active", on);
      btn.setAttribute("aria-selected", String(on));
    }
    this.#loadActive();
  }

  #loadActive() {
    return this.#active === "os" ? this.#loadOs() : this.#loadPortHippo();
  }

  // ── Port Hippo tab (the accepted-keys store — manageable) ────────────────────

  /**
   * Pull the accepted-key list from main and render it. A genuine failure to load
   * (missing bridge, or the invoke rejects) is a distinct error state with a retry
   * — kept separate from a successful read of an empty store so "couldn't load"
   * never masquerades as "no keys trusted".
   */
  async #loadPortHippo() {
    const region = this.#renderBody(t("settings.hostkeys.help"));
    const list = this.#porthippo?.hostkeys?.list;
    if (typeof list !== "function") {
      this.#renderError(region, () => this.#loadPortHippo());
      return;
    }
    let entries;
    try {
      entries = (await this.#porthippo.hostkeys.list()) || [];
    } catch {
      this.#renderError(region, () => this.#loadPortHippo());
      return;
    }
    // Alphabetical by host:port for a stable inventory.
    const sorted = [...entries].sort((a, b) =>
      a.hostPort.localeCompare(b.hostPort),
    );
    if (sorted.length === 0) {
      this.#renderEmpty(region, t("settings.hostkeys.empty"));
      return;
    }
    region.append(
      el(
        "div",
        { class: "hostkeys-list", role: "list" },
        sorted.map((entry) => this.#row(entry)),
      ),
    );
  }

  // One accepted host: identity + fingerprint on the left, added-date + the forget
  // action on the right. The action cell swaps between button and inline confirm in
  // place (single-popup rule — no nested dialog).
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
    if (!res || !res.__hippoError) this.#loadPortHippo();
  }

  // ── Operating System tab (~/.ssh/known_hosts — read-only) ────────────────────

  /**
   * Pull the OS known_hosts inventory from main and render it read-only, headed by
   * a note that Port Hippo can't manage it and a reference to the file. Same
   * error/empty discipline as the Port Hippo tab.
   */
  async #loadOs() {
    const region = this.#renderBody(t("settings.hostkeys.os.help"));
    const listOs = this.#porthippo?.hostkeys?.listOs;
    if (typeof listOs !== "function") {
      this.#renderError(region, () => this.#loadOs());
      return;
    }
    let data;
    try {
      data = (await this.#porthippo.hostkeys.listOs()) || {};
    } catch {
      this.#renderError(region, () => this.#loadOs());
      return;
    }
    const path = typeof data.path === "string" ? data.path : "";
    const entries = Array.isArray(data.entries) ? data.entries : [];

    // Insert the "found in <path>" reference just before the list region (so it
    // shows even when the list is empty). Guarded by parentNode so a stale load
    // whose tab the user switched away from writes nothing.
    if (path && region.parentNode) {
      region.parentNode.insertBefore(
        el("p", {
          class: "hostkeys-os-path",
          text: t("settings.hostkeys.os.path", { path }),
        }),
        region,
      );
    }
    if (entries.length === 0) {
      this.#renderEmpty(region, t("settings.hostkeys.os.empty"));
      return;
    }
    // Alphabetical by host (hashed hosts, which sort as "", fall first), then
    // fingerprint for a stable order among same-host keys.
    const sorted = [...entries].sort(
      (a, b) =>
        (a.host || "").localeCompare(b.host || "") ||
        String(a.fingerprint).localeCompare(String(b.fingerprint)),
    );
    region.append(
      el(
        "div",
        { class: "hostkeys-list", role: "list" },
        sorted.map((entry) => this.#osRow(entry)),
      ),
    );
  }

  // One OS host key: identity + fingerprint, with the key type as read-only meta.
  // No forget action — Port Hippo can't edit ~/.ssh/known_hosts.
  #osRow(entry) {
    const host = entry.host || t("settings.hostkeys.os.hashed");
    return el(
      "div",
      { class: "hostkeys-item hostkeys-item--readonly", role: "listitem" },
      [
        el("div", { class: "hostkeys-info" }, [
          el("div", { class: "hostkeys-host", text: host }),
          el("div", {
            class: "hostkeys-fingerprint",
            text: entry.fingerprint,
          }),
        ]),
        el("div", { class: "hostkeys-meta" }, [
          el("span", {
            class: "hostkeys-keytype",
            text: entry.keyType || "",
          }),
        ]),
      ],
    );
  }

  // ── Shared body rendering ────────────────────────────────────────────────────

  /**
   * Reset the tab body to a help line and a fresh, empty list region, and return
   * that region for the caller to fill. Returning a FRESH region each load means a
   * slow, stale async completion writes into a detached node rather than the tab
   * the user has since switched to.
   */
  #renderBody(help) {
    const region = el("div", { class: "hostkeys-list-region" });
    clear(this.#body).append(
      el("p", { class: "settings-help", text: help }),
      region,
    );
    return region;
  }

  #renderEmpty(region, text) {
    clear(region).append(el("p", { class: "hostkeys-empty", text }));
  }

  // The list couldn't be read (missing bridge / rejected invoke). Show it as an
  // error — announced via role="alert" — with a Retry that re-runs the active
  // tab's load, rather than the empty state, which would falsely read as "none".
  #renderError(region, retry) {
    clear(region).append(
      el("div", { class: "hostkeys-error", role: "alert" }, [
        el("p", {
          class: "hostkeys-error-message",
          text: t("settings.hostkeys.loadError"),
        }),
        el("button", {
          class: "btn btn--secondary hostkeys-retry",
          type: "button",
          text: t("settings.hostkeys.retry"),
          onClick: () => retry(),
        }),
      ]),
    );
  }
}
