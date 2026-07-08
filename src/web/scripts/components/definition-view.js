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

// definition-view.js — the Definition pane: a master list of tunnel definitions
// on the left, an inline TunnelEditor on the right. The list shows each tunnel's
// name, local→destination summary, live state badge and an arm/disarm toggle, and
// supports create / delete / reorder. Live state comes from the engine's
// `porthippo:tunnel-state` broadcast (seeded once from `tunnels.status()`), so a
// tunnel armed here shows its progression (listening → connecting → connected)
// without a poll. All native work (store, engine, dialogs) goes through
// `window.porthippo.*`; this component never touches IPC channels directly.

import { el, clear } from "../dom.js";
import { t } from "../strings.js";
import { PopupManager } from "../popup-manager.js";
import { TunnelEditor } from "./tunnel-editor.js";

/** Armed = the engine holds this tunnel (anything but disarmed / error / unknown). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

export class DefinitionView {
  #el;
  #listEl;
  #emptyEl;
  #editorHost;
  #placeholderEl;
  #editor;
  #defs = [];
  #states = new Map(); // id → latest state string
  #selectedId = null;
  #creating = false;
  #porthippo;
  #onTunnelState;

  /**
   * @param {object} [opts]
   * @param {object} [opts.porthippo]  the IPC bridge (defaults to window.porthippo)
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ porthippo, openKeyFile } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#editor = new TunnelEditor({
      openKeyFile,
      onSubmit: (payload, ctx) => this.#submit(payload, ctx),
      onSaved: (record) => this.#afterSaved(record),
      onCancel: () => this.#cancelEdit(),
    });
    this.#el = this.#build();

    this.#onTunnelState = (event) => this.#applyState(event.detail);
    window.addEventListener("porthippo:tunnel-state", this.#onTunnelState);
  }

  get element() {
    return this.#el;
  }

  /** Load definitions + seed live state. Call once after mount. */
  async load() {
    const [defs, status] = await Promise.all([
      this.#porthippo?.tunnels?.list?.() ?? [],
      this.#porthippo?.tunnels?.status?.() ?? [],
    ]);
    this.#defs = Array.isArray(defs) ? defs : [];
    if (Array.isArray(status)) {
      for (const s of status) if (s && s.id) this.#states.set(s.id, s.state);
    }
    // Preserve a valid selection across reloads; otherwise fall back to placeholder.
    if (
      this.#selectedId &&
      !this.#defs.some((d) => d.id === this.#selectedId)
    ) {
      this.#selectedId = null;
      this.#creating = false;
      this.#showEditor(false);
    }
    this.#renderList();
  }

  /**
   * Open a definition for editing by id (used by the Monitoring view's edit
   * affordance). No-op if the id isn't in the loaded list.
   * @param {string} id
   */
  selectById(id) {
    if (this.#defs.some((d) => d.id === id)) this.#select(id);
  }

  destroy() {
    window.removeEventListener("porthippo:tunnel-state", this.#onTunnelState);
    this.#editor.destroy();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  #build() {
    this.#listEl = el("div", { class: "def-list", role: "list" });
    this.#emptyEl = el("div", { class: "def-empty" }, [
      el("p", { class: "def-empty-title", text: t("def.list.empty") }),
      el("p", { class: "def-empty-hint", text: t("def.list.emptyHint") }),
    ]);
    this.#placeholderEl = el("div", { class: "def-editor-placeholder" }, [
      el("p", { text: t("def.editor.none") }),
    ]);
    this.#editorHost = el("div", { class: "def-editor-host" }, [
      this.#placeholderEl,
      this.#editor.element,
    ]);
    this.#editor.element.hidden = true;

    return el("div", { class: "definition-view" }, [
      el("div", { class: "def-list-pane" }, [
        el("div", { class: "def-list-header" }, [
          el("span", { class: "def-list-title", text: t("def.list.title") }),
          el("button", {
            class: "btn btn--primary def-add-btn",
            type: "button",
            text: t("def.list.add"),
            onClick: () => this.#createNew(),
          }),
        ]),
        this.#emptyEl,
        this.#listEl,
      ]),
      el("div", { class: "def-editor-pane" }, [this.#editorHost]),
    ]);
  }

  #renderList() {
    clear(this.#listEl);
    this.#emptyEl.hidden = this.#defs.length > 0;
    this.#defs.forEach((def, i) =>
      this.#listEl.appendChild(this.#renderRow(def, i)),
    );
  }

  #renderRow(def, index) {
    const state = this.#states.get(def.id) || "disarmed";
    const armed = isArmed(state);
    const selected = def.id === this.#selectedId;

    const badge = el("span", {
      class: `def-badge def-badge--${state}`,
      text: t(`state.${state}`),
      title: state === "error" ? this.#states.get(`${def.id}:error`) || "" : "",
    });

    const armBtn = el("button", {
      class:
        `btn btn--secondary def-arm-btn ${armed ? "def-arm-btn--armed" : ""}`.trim(),
      type: "button",
      text: armed ? t("def.list.disarm") : t("def.list.arm"),
      title: armed ? t("def.list.disarm") : t("def.list.arm"),
      onClick: (e) => {
        e.stopPropagation();
        this.#toggleArm(def, armed);
      },
    });

    const tools = el("div", { class: "def-row-tools" }, [
      this.#toolBtn(t("def.list.moveUp"), "↑", index === 0, (e) => {
        e.stopPropagation();
        this.#move(index, -1);
      }),
      this.#toolBtn(
        t("def.list.moveDown"),
        "↓",
        index === this.#defs.length - 1,
        (e) => {
          e.stopPropagation();
          this.#move(index, 1);
        },
      ),
      this.#toolBtn(
        t("def.list.delete"),
        "✕",
        false,
        (e) => {
          e.stopPropagation();
          this.#confirmDelete(def);
        },
        "def-delete-btn",
      ),
    ]);

    return el(
      "div",
      {
        class: `def-row ${selected ? "def-row--selected" : ""}`.trim(),
        role: "listitem",
        tabindex: "0",
        onClick: () => this.#select(def.id),
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.#select(def.id);
          }
        },
      },
      [
        el("div", { class: "def-row-main" }, [
          el("span", {
            class: "def-row-name",
            text: def.name || t("def.unnamed"),
          }),
          el("span", {
            class: "def-row-summary",
            text: t("def.list.summary", {
              localPort: def.localPort ?? "?",
              host: def.destination?.host ?? "?",
              port: def.destination?.port ?? "?",
            }),
          }),
        ]),
        badge,
        armBtn,
        tools,
      ],
    );
  }

  #toolBtn(label, glyph, disabled, onClick, extraClass = "") {
    return el("button", {
      class: `btn btn--icon def-tool-btn ${extraClass}`.trim(),
      type: "button",
      title: label,
      "aria-label": label,
      text: glyph,
      disabled,
      onClick,
    });
  }

  // ── Selection / editor visibility ─────────────────────────────────────────

  #select(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    this.#selectedId = id;
    this.#creating = false;
    this.#editor.setValue(def);
    this.#showEditor(true);
    this.#renderList();
  }

  #createNew() {
    this.#selectedId = null;
    this.#creating = true;
    this.#editor.setValue(null);
    this.#showEditor(true);
    this.#renderList();
  }

  #cancelEdit() {
    this.#selectedId = null;
    this.#creating = false;
    this.#showEditor(false);
    this.#renderList();
  }

  #showEditor(show) {
    this.#editor.element.hidden = !show;
    this.#placeholderEl.hidden = show;
  }

  // ── Store writes ──────────────────────────────────────────────────────────

  #submit(payload, { id }) {
    return id
      ? this.#porthippo.tunnels.update(id, payload)
      : this.#porthippo.tunnels.create(payload);
  }

  async #afterSaved(record) {
    const id = record && record.id;
    this.#notifyChanged();
    await this.load();
    if (id) this.#select(id);
  }

  async #confirmDelete(def) {
    PopupManager.confirmDelete({
      message: t("def.delete.message", { name: def.name || t("def.unnamed") }),
      onConfirm: async () => {
        const result = await this.#porthippo.tunnels.delete(def.id);
        if (result && result.__hippoError) {
          PopupManager.notify({ message: result.message || "Delete failed" });
          return;
        }
        if (this.#selectedId === def.id) this.#cancelEdit();
        this.#notifyChanged();
        await this.load();
      },
    });
  }

  async #move(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= this.#defs.length) return;
    const ids = this.#defs.map((d) => d.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    const result = await this.#porthippo.tunnels.reorder(ids);
    if (result && result.__hippoError) return;
    this.#notifyChanged();
    await this.load();
  }

  async #toggleArm(def, armed) {
    const call = armed
      ? this.#porthippo.tunnels.disarm(def.id)
      : this.#porthippo.tunnels.arm(def.id);
    // Optimistic: reflect the intent immediately; the broadcast will correct it.
    this.#states.set(def.id, armed ? "disarmed" : "listening");
    this.#renderList();
    const result = await call;
    if (result && result.__hippoError) {
      PopupManager.notify({ message: result.message || "Engine error" });
    }
  }

  // ── Live state ────────────────────────────────────────────────────────────

  #applyState(detail) {
    if (!detail || !detail.id) return;
    if (detail.removed) {
      this.#states.delete(detail.id);
    } else {
      this.#states.set(detail.id, detail.state);
      if (detail.error) this.#states.set(`${detail.id}:error`, detail.error);
    }
    // Only re-render if this tunnel is on screen.
    if (this.#defs.some((d) => d.id === detail.id)) this.#renderList();
  }

  #notifyChanged() {
    window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
  }
}
