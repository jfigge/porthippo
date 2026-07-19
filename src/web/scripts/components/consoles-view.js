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

// consoles-view.js — the CONSOLES section controller (Feature 200): the console
// sibling of TunnelsView, but lean. It owns the console IPC (window.jumphippo
// .consoles.*), the ConsoleEditorDialog, and the ConsoleList, and mounts into the
// sidebar stack beneath the TUNNELS section. Opening a console launches its own
// terminal window (main process) — there is no detail pane here. Live session
// state arrives over `jumphippo:console-state` and drives each row's status lamp.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { ConsoleList } from "./console-list.js";
import { ConsoleEditorDialog } from "./console-editor-dialog.js";

/** Lamp priority when a console has more than one open session. */
function rankState(s) {
  if (s === "connected") return 3;
  if (s === "error") return 2;
  if (s === "connecting") return 1;
  return 0;
}

export class ConsolesView {
  #el;
  #jumphippo;
  #list;
  #editor;

  #defs = [];
  #sessions = new Map(); // sessionId → { id, state } — the live open sessions
  #states = new Map(); // consoleId → aggregate lamp state
  #selectedId = null;

  #onConsolesChanged;
  #onConsoleState;
  #onNewConsole;

  constructor({ jumphippo, openKeyFile } = {}) {
    this.#jumphippo = jumphippo || window.jumphippo;

    this.#editor = new ConsoleEditorDialog({
      jumphippo: this.#jumphippo,
      openKeyFile,
      onSaved: (record) => this.#afterSaved(record),
    });

    this.#list = new ConsoleList({
      onSelect: (id) => this.#select(id),
      onAdd: () => this.#editor.openCreate(),
      onOpen: (id) => this.#open(id),
      onContextMenu: (id) => this.#showContextMenu(id),
    });

    this.#el = el("div", { class: "consoles-view" }, [
      this.#list.element,
      this.#editor.element,
    ]);

    this.#onConsolesChanged = () => this.load();
    this.#onConsoleState = (e) => this.#applyState(e.detail);
    this.#onNewConsole = () => this.createNew();
    window.addEventListener(
      "jumphippo:consoles-changed",
      this.#onConsolesChanged,
    );
    window.addEventListener("jumphippo:console-state", this.#onConsoleState);
    window.addEventListener("jumphippo:new-console", this.#onNewConsole);
  }

  get element() {
    return this.#el;
  }

  /** Load the console list + the currently-open sessions, then render. */
  async load() {
    const [defs, sessions] = await Promise.all([
      this.#jumphippo?.consoles?.list?.() ?? [],
      this.#jumphippo?.consoles?.sessions?.() ?? [],
    ]);
    this.#defs = Array.isArray(defs) ? defs : [];
    this.#sessions.clear();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (s && s.sessionId) {
        this.#sessions.set(s.sessionId, { id: s.id, state: s.state });
      }
    }
    this.#recomputeStates();
    this.#list.setData(this.#defs, this.#states, this.#selectedId);
  }

  /** Open a blank console editor (the File ▸ New Console menu command). */
  createNew() {
    this.#editor.openCreate();
  }

  /** Remove the global listeners (symmetry with the app teardown). */
  destroy() {
    window.removeEventListener(
      "jumphippo:consoles-changed",
      this.#onConsolesChanged,
    );
    window.removeEventListener("jumphippo:console-state", this.#onConsoleState);
    window.removeEventListener("jumphippo:new-console", this.#onNewConsole);
  }

  // ── Actions ───────────────────────────────────────────────────────────────────

  #select(id) {
    this.#selectedId = id;
    this.#list.setSelected(id);
  }

  async #open(id) {
    const result = await this.#jumphippo?.consoles?.open?.(id);
    if (result && result.__hippoError) {
      PopupManager.notify({
        message: result.message || t("consoles.openError"),
      });
    }
    // Success opens a terminal window; row state follows via jumphippo:console-state.
  }

  #editById(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (def) this.#editor.openEdit(def);
  }

  #afterSaved(record) {
    if (record && record.id) this.#selectedId = record.id;
    this.load();
  }

  async #showContextMenu(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    this.#select(id);
    const items = [
      { id: "open", label: t("consoles.menu.open") },
      { type: "separator" },
      { id: "edit", label: t("consoles.menu.edit") },
      { id: "delete", label: t("consoles.menu.delete") },
    ];
    const action = await this.#jumphippo?.contextMenu?.popup?.({ items });
    switch (action) {
      case "open":
        this.#open(id);
        break;
      case "edit":
        this.#editById(id);
        break;
      case "delete":
        this.#confirmDelete(id);
        break;
      default:
        break;
    }
  }

  #confirmDelete(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    PopupManager.confirmDelete({
      message: t("consoles.delete.message", {
        name: def.name || t("consoles.unnamed"),
      }),
      onConfirm: async () => {
        const result = await this.#jumphippo.consoles.delete(id);
        if (result && result.__hippoError) {
          PopupManager.notify({ message: result.message || "Delete failed" });
          return;
        }
        window.dispatchEvent(new CustomEvent("jumphippo:consoles-changed"));
        if (this.#selectedId === id) this.#selectedId = null;
        await this.load();
      },
    });
  }

  // ── Live session state → row lamps ────────────────────────────────────────────

  #applyState(detail) {
    if (!detail || !detail.sessionId) return;
    const { id, sessionId, state } = detail;
    if (state === "closed" || state === "error") {
      this.#sessions.delete(sessionId);
    } else {
      this.#sessions.set(sessionId, { id, state });
    }
    this.#recomputeStates();
    if (id) this.#list.updateState(id, this.#states.get(id) || null);
  }

  /** Aggregate each console's lamp from its open sessions (connected wins). */
  #recomputeStates() {
    const byConsole = new Map();
    for (const { id, state } of this.#sessions.values()) {
      if (!id) continue;
      const prev = byConsole.get(id);
      if (prev === undefined || rankState(state) > rankState(prev)) {
        byConsole.set(id, state);
      }
    }
    this.#states = byConsole;
  }
}
