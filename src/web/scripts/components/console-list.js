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

// console-list.js — the CONSOLES section of the sidebar (Feature 200): a flat list
// of console rows, one each with a session status signal, a terminal glyph, and the
// name. An Add icon sits in the header; open / edit / delete live on the row's
// right-click context menu (owned by ConsolesView). Double-click or Enter opens the
// console. This is deliberately the LEAN sibling of tunnel-list.js — no groups, no
// drag & drop (out of v1 scope) — reusing the same sidebar/row CSS and the shared
// status-signal helpers so the two sections read as one tree.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { buildSignal, signalLamp } from "./tunnel-list.js";

export class ConsoleList {
  #el;
  #listEl;
  #emptyEl;
  #defs = [];
  #states = new Map(); // consoleId → session state (connecting|connected|error|…)
  #selectedId = null;
  #rows = new Map(); // id → { root, signal }

  #onSelect;
  #onAdd;
  #onOpen;
  #onContextMenu;

  constructor({ onSelect, onAdd, onOpen, onContextMenu } = {}) {
    this.#onSelect = onSelect || (() => {});
    this.#onAdd = onAdd || (() => {});
    this.#onOpen = onOpen || (() => {});
    this.#onContextMenu = onContextMenu || (() => {});
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  #build() {
    this.#listEl = el("div", { class: "tunnel-list", role: "list" });
    this.#emptyEl = el("div", { class: "tunnel-list-empty" }, [
      el("p", { class: "tunnel-list-empty-title", text: t("consoles.empty") }),
      el("p", {
        class: "tunnel-list-empty-hint",
        text: t("consoles.emptyHint"),
      }),
    ]);

    const addBtn = el("button", {
      class: "btn--icon tunnel-add-btn",
      type: "button",
      title: t("consoles.add"),
      "aria-label": t("consoles.add"),
      html: icons.add(),
      onClick: () => this.#onAdd(),
    });

    return el(
      "aside",
      {
        class: "tunnel-sidebar tunnel-sidebar--consoles",
        "aria-label": t("consoles.title"),
      },
      [
        el("div", { class: "tunnel-sidebar-header" }, [
          el("span", {
            class: "tunnel-sidebar-title",
            text: t("consoles.title"),
          }),
          addBtn,
        ]),
        this.#emptyEl,
        this.#listEl,
      ],
    );
  }

  /** Feed the console list + a per-console session-state map + the selection. */
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

  /** Update one row's session status signal in place from a live-state change. */
  updateState(id, state) {
    if (state) this.#states.set(id, state);
    else this.#states.delete(id);
    const rec = this.#rows.get(id);
    if (rec) {
      const lamp = signalLamp(state);
      rec.signal.className = `tunnel-signal${lamp === "off" ? "" : ` tunnel-signal--${lamp}`}`;
      rec.signal.title = t(`state.${state || "disarmed"}`);
      rec.signal.setAttribute("aria-label", t(`state.${state || "disarmed"}`));
    }
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
    // A console's row state is its live session state (off when no session is open).
    const state = this.#states.get(def.id) || "disarmed";
    const signal = buildSignal(state);

    const typeIcon = el("span", {
      class: "tunnel-type-icon tunnel-type-icon--console",
      html: icons.terminal(),
      role: "img",
      title: t("consoles.title"),
      "aria-label": t("consoles.title"),
    });

    const root = el(
      "div",
      {
        class: "tunnel-row",
        role: "listitem",
        tabindex: "0",
        dataset: { id: def.id },
        onClick: () => this.#onSelect(def.id),
        // Double-click opens the console shell (like double-clicking a file).
        onDblclick: () => this.#onOpen(def.id),
        onKeydown: (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.#onOpen(def.id);
          } else if (e.key === " ") {
            e.preventDefault();
            this.#onSelect(def.id);
          }
        },
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onContextMenu(def.id);
        },
      },
      [
        signal,
        typeIcon,
        el("span", {
          class: "tunnel-row-name",
          text: def.name || t("consoles.unnamed"),
        }),
      ],
    );

    return { root, signal };
  }
}
