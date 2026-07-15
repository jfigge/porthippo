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

// tunnel-list.js — the master sidebar: a flat list of tunnels, one row each with
// a status dot, the local port, the name, and (on hover/focus) a quick-edit icon
// button. An Add icon sits in the header; delete (and the other row actions) live
// on the row's right-click context menu, owned by TunnelsView. Selection, add,
// edit and context-menu requests are reported to the owning TunnelsView via
// constructor callbacks; the list itself holds no IPC and computes nothing —
// state is fed in.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

/**
 * The status-dot bucket for a live state: grey `disarmed`, green `armed`
 * (listening / connecting / connected), yellow `paused`, red `error`.
 * @param {string} state
 * @returns {"disarmed"|"armed"|"paused"|"error"}
 */
export function dotState(state) {
  if (state === "paused") return "paused";
  if (state === "error") return "error";
  if (state && state !== "disarmed") return "armed";
  return "disarmed";
}

/**
 * A compact forwarding-type badge for a row (Feature 110), or null for the default
 * `local` type (which stays unbadged to keep the common case clean). The full type
 * name is the tooltip.
 * @param {object} def
 * @returns {HTMLElement|null}
 */
export function typeBadge(def) {
  const type = (def && def.type) || "local";
  if (type !== "remote" && type !== "dynamic") return null;
  return el("span", {
    class: `tunnel-type-badge tunnel-type-badge--${type}`,
    text: t(`type.badge.${type}`),
    title: t(`editor.type.${type}`),
  });
}

export class TunnelList {
  #el;
  #listEl;
  #emptyEl;
  #defs = [];
  #states = new Map();
  #selectedId = null;
  #rows = new Map(); // id → { root, dot }
  #onSelect;
  #onAdd;
  #onEdit;
  #onContextMenu;

  constructor({ onSelect, onAdd, onEdit, onContextMenu } = {}) {
    this.#onSelect = onSelect || (() => {});
    this.#onAdd = onAdd || (() => {});
    this.#onEdit = onEdit || (() => {});
    this.#onContextMenu = onContextMenu || (() => {});
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  #build() {
    this.#listEl = el("div", { class: "tunnel-list", role: "list" });
    this.#emptyEl = el("div", { class: "tunnel-list-empty" }, [
      el("p", { class: "tunnel-list-empty-title", text: t("tunnels.empty") }),
      el("p", {
        class: "tunnel-list-empty-hint",
        text: t("tunnels.emptyHint"),
      }),
    ]);

    const addBtn = el("button", {
      class: "btn--icon tunnel-add-btn",
      type: "button",
      title: t("tunnels.add"),
      "aria-label": t("tunnels.add"),
      html: icons.add(),
      onClick: () => this.#onAdd(),
    });

    return el(
      "aside",
      { class: "tunnel-sidebar", "aria-label": t("tunnels.title") },
      [
        el("div", { class: "tunnel-sidebar-header" }, [
          el("span", {
            class: "tunnel-sidebar-title",
            text: t("tunnels.title"),
          }),
          addBtn,
        ]),
        this.#emptyEl,
        this.#listEl,
      ],
    );
  }

  /** Feed the definition list + a state map, optionally (re)setting the selection. */
  setData(defs, states, selectedId) {
    this.#defs = Array.isArray(defs) ? defs : [];
    this.#states = states instanceof Map ? states : new Map();
    if (selectedId !== undefined) this.#selectedId = selectedId;
    this.#render();
  }

  /** Highlight the selected row (no re-render). */
  setSelected(id) {
    this.#selectedId = id;
    for (const [rowId, rec] of this.#rows) {
      const on = rowId === id;
      rec.root.classList.toggle("tunnel-row--selected", on);
      rec.root.setAttribute("aria-selected", String(on));
    }
  }

  /** Update one row's status dot in place from a live-state change. */
  updateState(id, state) {
    this.#states.set(id, state);
    const rec = this.#rows.get(id);
    if (!rec) return;
    rec.dot.className = `tunnel-dot tunnel-dot--${dotState(state)}`;
    rec.dot.title = t(`state.${state}`);
  }

  #render() {
    clear(this.#listEl);
    this.#rows.clear();
    const empty = this.#defs.length === 0;
    this.#emptyEl.hidden = !empty;
    this.#listEl.hidden = empty;
    for (const def of this.#defs) {
      const rec = this.#buildRow(def);
      this.#rows.set(def.id, rec);
      this.#listEl.appendChild(rec.root);
    }
    this.setSelected(this.#selectedId);
  }

  #buildRow(def) {
    const state = this.#states.get(def.id) || "disarmed";
    const dot = el("span", {
      class: `tunnel-dot tunnel-dot--${dotState(state)}`,
      title: t(`state.${state}`),
    });
    // Delete is offered from the row's right-click context menu (TunnelsView),
    // so the sidebar row keeps only the quick-edit affordance on hover.
    const tools = el("div", { class: "tunnel-row-tools" }, [
      el("button", {
        class: "btn--icon tunnel-row-btn tunnel-edit-btn",
        type: "button",
        title: t("tunnels.edit"),
        "aria-label": t("tunnels.edit"),
        html: icons.edit(),
        onClick: (e) => {
          e.stopPropagation();
          this.#onEdit(def.id);
        },
      }),
    ]);

    const root = el(
      "div",
      {
        class: "tunnel-row",
        role: "listitem",
        tabindex: "0",
        dataset: { id: def.id },
        onClick: () => this.#onSelect(def.id),
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.#onSelect(def.id);
          }
        },
        // Secondary (right) click opens the native OS row menu.
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onContextMenu(def.id);
        },
      },
      [
        dot,
        el("span", {
          class: "tunnel-row-port",
          text: String(def.localPort ?? "—"),
        }),
        typeBadge(def),
        el("span", {
          class: "tunnel-row-name",
          text: def.name || t("def.unnamed"),
        }),
        tools,
      ],
    );

    return { root, dot };
  }
}
