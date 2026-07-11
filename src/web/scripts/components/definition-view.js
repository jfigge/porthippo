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

// definition-view.js — the Definition pane. Since Feature 45 the tunnel LIST is
// the whole surface: each row shows the state badge, name, the store-computed
// route summary, an arm/disarm toggle, and edit / duplicate / delete actions. All
// editing happens in a modal TunnelEditorDialog launched from Add or Edit, so the
// common fields fit in one dialog with the SSH server + local host a disclosure
// away. Live state comes from the engine's `porthippo:tunnel-state` broadcast
// (seeded once from `tunnels.status()`). All native work goes through
// `window.porthippo.*`; this component never touches IPC channels directly.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { TunnelEditorDialog } from "./tunnel-editor-dialog.js";

/** Armed = the engine holds this tunnel (anything but disarmed / error / unknown). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

export class DefinitionView {
  #el;
  #listEl;
  #emptyEl;
  #editor;
  #defs = [];
  #states = new Map(); // id → latest state string
  #porthippo;
  #onTunnelState;

  /**
   * @param {object} [opts]
   * @param {object} [opts.porthippo]  the IPC bridge (defaults to window.porthippo)
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ porthippo, openKeyFile } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#editor = new TunnelEditorDialog({
      porthippo: this.#porthippo,
      openKeyFile,
      onSubmit: (payload, ctx) => this.#submit(payload, ctx),
      onSaved: (record) => this.#afterSaved(record),
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
    this.#renderList();
  }

  /** Open the editor for a tunnel by id (used by Monitoring's edit affordance). */
  selectById(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (def) this.#editor.openEdit(def);
  }

  /** Open a blank editor (used by the menu/tray "New Tunnel"). */
  createNew() {
    this.#editor.openCreate();
  }

  destroy() {
    window.removeEventListener("porthippo:tunnel-state", this.#onTunnelState);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  #build() {
    this.#listEl = el("div", { class: "def-list", role: "list" });
    this.#emptyEl = el("div", { class: "def-empty" }, [
      el("p", { class: "def-empty-title", text: t("def.list.empty") }),
      el("p", { class: "def-empty-hint", text: t("def.list.emptyHint") }),
    ]);

    return el("div", { class: "definition-view" }, [
      el("div", { class: "def-list-header" }, [
        el("span", { class: "def-list-title", text: t("def.list.title") }),
        el("button", {
          class: "btn btn--primary def-add-btn",
          type: "button",
          text: t("def.list.add"),
          onClick: () => this.createNew(),
        }),
      ]),
      this.#emptyEl,
      this.#listEl,
      this.#editor.element,
    ]);
  }

  #renderList() {
    clear(this.#listEl);
    this.#emptyEl.hidden = this.#defs.length > 0;
    this.#defs.forEach((def) => this.#listEl.appendChild(this.#renderRow(def)));
  }

  #renderRow(def) {
    const state = this.#states.get(def.id) || "disarmed";
    const armed = isArmed(state);

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
      // Read the CURRENT state at click time — the row updates in place, so a
      // captured `armed` would go stale after a state change.
      onClick: () =>
        this.#toggleArm(def, isArmed(this.#states.get(def.id) || "disarmed")),
    });

    const tools = el("div", { class: "def-row-tools" }, [
      this.#toolBtn(
        t("def.list.edit"),
        "✎",
        () => this.#editor.openEdit(def),
        "def-edit-btn",
      ),
      this.#toolBtn(
        t("def.list.duplicate"),
        "⧉",
        () => this.#duplicate(def),
        "def-duplicate-btn",
      ),
      this.#toolBtn(
        t("def.list.delete"),
        "✕",
        () => this.#confirmDelete(def),
        "def-delete-btn",
      ),
    ]);

    return el(
      "div",
      { class: "def-row", role: "listitem", dataset: { id: def.id } },
      [
        el("div", { class: "def-row-main" }, [
          el("span", {
            class: "def-row-name",
            text: def.name || t("def.unnamed"),
          }),
          el("span", {
            class: "def-row-summary",
            text: def.routeSummary || "",
          }),
        ]),
        badge,
        armBtn,
        tools,
      ],
    );
  }

  #rowFor(id) {
    for (const row of this.#listEl.children) {
      if (row.dataset && row.dataset.id === id) return row;
    }
    return null;
  }

  /**
   * Refresh one row's badge + arm button IN PLACE (like MonitoringView), so a
   * state broadcast or an arm toggle never clears the list and steals keyboard
   * focus from the control the user is on. Falls back to a full render only when
   * the row is missing (a definition was added or removed).
   */
  #updateRow(id) {
    const row = this.#rowFor(id);
    if (!row) {
      this.#renderList();
      return;
    }
    const state = this.#states.get(id) || "disarmed";
    const armed = isArmed(state);

    const badge = row.querySelector(".def-badge");
    if (badge) {
      badge.className = `def-badge def-badge--${state}`;
      badge.textContent = t(`state.${state}`);
      badge.title =
        state === "error" ? this.#states.get(`${id}:error`) || "" : "";
    }
    const armBtn = row.querySelector(".def-arm-btn");
    if (armBtn) {
      armBtn.className =
        `btn btn--secondary def-arm-btn ${armed ? "def-arm-btn--armed" : ""}`.trim();
      armBtn.textContent = armed ? t("def.list.disarm") : t("def.list.arm");
      armBtn.title = armBtn.textContent;
    }
  }

  #toolBtn(label, glyph, onClick, extraClass = "") {
    return el("button", {
      class: `btn btn--icon def-tool-btn ${extraClass}`.trim(),
      type: "button",
      title: label,
      "aria-label": label,
      text: glyph,
      onClick,
    });
  }

  // ── Store writes ──────────────────────────────────────────────────────────

  #submit(payload, { id }) {
    return id
      ? this.#porthippo.tunnels.update(id, payload)
      : this.#porthippo.tunnels.create(payload);
  }

  async #afterSaved() {
    this.#notifyChanged();
    await this.load();
  }

  #duplicate(def) {
    const copy = { ...def };
    delete copy.id;
    delete copy.order;
    delete copy.routeSummary;
    copy.name = `${def.name || t("def.unnamed")}${t("editor.duplicateSuffix")}`;
    this.#porthippo.tunnels.create(copy).then((result) => {
      if (result && result.__hippoError) {
        PopupManager.notify({ message: result.message || "Duplicate failed" });
        return;
      }
      this.#afterSaved();
    });
  }

  #confirmDelete(def) {
    PopupManager.confirmDelete({
      message: t("def.delete.message", { name: def.name || t("def.unnamed") }),
      onConfirm: async () => {
        const result = await this.#porthippo.tunnels.delete(def.id);
        if (result && result.__hippoError) {
          PopupManager.notify({ message: result.message || "Delete failed" });
          return;
        }
        this.#notifyChanged();
        await this.load();
      },
    });
  }

  async #toggleArm(def, armed) {
    const call = armed
      ? this.#porthippo.tunnels.disarm(def.id)
      : this.#porthippo.tunnels.arm(def.id);
    // Optimistic: reflect the intent immediately; the broadcast will correct it.
    this.#states.set(def.id, armed ? "disarmed" : "listening");
    this.#updateRow(def.id);
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
    if (this.#defs.some((d) => d.id === detail.id)) this.#updateRow(detail.id);
  }

  #notifyChanged() {
    window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
  }
}
