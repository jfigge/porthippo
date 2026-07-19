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

// jump-host-picker-field.js — build the ordered jump-host chain a tunnel routes
// through. It renders the chosen hops as a reorderable list, plus a picker row: a
// <select> of every known jump host (the "focused" host) with icon actions — Add
// (append it to the chain), New… (create one), Edit (edit the focused record) and
// Delete (remove the focused record entirely). New…/Edit open the
// JumpHostEditorDialog; Delete confirms, then removes the reusable record (blocked
// with an explanation when a tunnel still uses it). Selecting focuses a host but
// doesn't mutate the chain, so a host can be edited/deleted without being added.
// Row order IS hop order; the chosen ids are reported up as `jumpHostIds[]` via the
// `onChange` callback. Reloads on `jumphippo:jumphosts-changed`, preserving the
// chain (dropping any deleted ref).

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { PopupManager } from "../popup-manager.js";
import { JumpHostEditorDialog } from "./jump-host-editor-dialog.js";

export class JumpHostPickerField {
  #el;
  #listEl;
  #emptyEl;
  #addSelect;
  #addBtn;
  #editBtn;
  #deleteBtn;
  #jumphippo;
  #openKeyFile;
  #onChange;
  #jumpHosts = []; // available records
  #chain = []; // ordered selected ids
  #selected = ""; // the host focused in the picker (Add/Edit target)
  #editor = null;
  #creating = false; // whether the open editor is a create (vs. edit)
  #onJumpsChanged;

  /**
   * @param {object} [opts]
   * @param {object} [opts.jumphippo]
   * @param {(ids: string[]) => void} [opts.onChange]
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ jumphippo, onChange, openKeyFile } = {}) {
    this.#jumphippo = jumphippo || window.jumphippo;
    this.#openKeyFile = openKeyFile;
    this.#onChange = onChange;
    this.#el = this.#build();

    this.#onJumpsChanged = () => this.refresh();
    window.addEventListener(
      "jumphippo:jumphosts-changed",
      this.#onJumpsChanged,
    );
  }

  get element() {
    return this.#el;
  }

  /** The ordered chain of jump-host ids. */
  get value() {
    return [...this.#chain];
  }

  /** Replace the chain (ids not in the known set are kept until refresh prunes). */
  setValue(ids) {
    this.#chain = Array.isArray(ids)
      ? ids.filter((x) => typeof x === "string")
      : [];
    this.#render();
  }

  /** Load available jump hosts. Call once after mount. */
  async load() {
    await this.refresh();
  }

  /** Reload the available jump hosts, pruning any chain ref that no longer exists. */
  async refresh() {
    const list = (await this.#jumphippo?.jumpHosts?.list?.()) || [];
    this.#jumpHosts = Array.isArray(list) ? list : [];
    const known = new Set(this.#jumpHosts.map((j) => j.id));
    const pruned = this.#chain.filter((id) => known.has(id));
    if (pruned.length !== this.#chain.length) {
      this.#chain = pruned;
      this.#onChange?.(this.value);
    }
    this.#render();
  }

  destroy() {
    window.removeEventListener(
      "jumphippo:jumphosts-changed",
      this.#onJumpsChanged,
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #build() {
    this.#listEl = el("div", { class: "jumps-chain" });
    this.#emptyEl = el("p", { class: "jumps-empty", text: t("jumps.empty") });
    this.#addSelect = el("select", {
      class: "dialog-input jumps-add-select",
      "aria-label": t("jumps.choose"),
      onChange: (e) => this.#focus(e.target.value),
    });
    this.#addBtn = this.#iconBtn(
      "jumps-add-btn",
      t("jumps.add"),
      icons.add(),
      () => this.#add(this.#selected),
      true,
    );
    const newBtn = this.#iconBtn(
      "jumps-new-btn",
      t("jumps.new"),
      icons.filePlus(),
      () => this.#openNew(),
    );
    this.#editBtn = this.#iconBtn(
      "jumps-edit-btn",
      t("common.edit"),
      icons.edit(),
      () => this.#openEdit(),
      true,
    );
    this.#deleteBtn = this.#iconBtn(
      "jumps-delete-btn",
      t("jumps.delete"),
      icons.trash(),
      () => this.#confirmDelete(),
      true,
    );

    return el("div", { class: "jump-host-picker" }, [
      el("div", { class: "jumps-header" }, [
        el("span", { class: "jumps-header-title", text: t("editor.jumps") }),
      ]),
      this.#emptyEl,
      this.#listEl,
      el("div", { class: "picker-row jumps-add-row" }, [
        this.#addSelect,
        this.#addBtn,
        newBtn,
        this.#editBtn,
        this.#deleteBtn,
      ]),
    ]);
  }

  /** A labelled icon button for the picker row. */
  #iconBtn(className, label, glyph, onClick, disabled = false) {
    return el("button", {
      class: `btn btn--icon ${className}`,
      type: "button",
      title: label,
      "aria-label": label,
      html: glyph,
      disabled,
      onClick,
    });
  }

  #byId(id) {
    return this.#jumpHosts.find((j) => j.id === id);
  }

  #render() {
    // Chain rows.
    clear(this.#listEl);
    this.#emptyEl.hidden = this.#chain.length > 0;
    this.#chain.forEach((id, i) => this.#listEl.appendChild(this.#row(id, i)));

    // The picker lists every known jump host so any of them can be focused for
    // editing; Add is what guards against re-adding one already in the chain.
    clear(this.#addSelect);
    this.#addSelect.append(
      el("option", { value: "", text: t("jumps.choose") }),
      ...this.#jumpHosts.map((j) =>
        el("option", { value: j.id, text: this.#label(j) }),
      ),
    );
    this.#addSelect.value = this.#selected;
    // A focused host that has since been deleted falls back to the placeholder.
    if (this.#addSelect.value !== this.#selected) this.#selected = "";
    this.#syncButtons();
  }

  // Enable Add only for a focused host not already in the chain; Edit + Delete for
  // any focused host.
  #syncButtons() {
    this.#addBtn.disabled =
      !this.#selected || this.#chain.includes(this.#selected);
    this.#editBtn.disabled = !this.#selected;
    this.#deleteBtn.disabled = !this.#selected;
  }

  // Focus a host in the picker (the Add/Edit target); does not touch the chain.
  #focus(id) {
    this.#selected = typeof id === "string" ? id : "";
    this.#syncButtons();
  }

  #row(id, index) {
    const record = this.#byId(id);
    const label = record ? this.#label(record) : t("jumps.missing");
    return el("div", { class: "jumps-chain-row" }, [
      el("span", { class: "jumps-chain-num", text: String(index + 1) }),
      el("span", { class: "jumps-chain-label", text: label }),
      el("div", { class: "jumps-chain-tools" }, [
        this.#tool(t("jumps.moveUp"), "↑", index === 0, () =>
          this.#move(index, -1),
        ),
        this.#tool(
          t("jumps.moveDown"),
          "↓",
          index === this.#chain.length - 1,
          () => this.#move(index, 1),
        ),
        this.#tool(t("jumps.remove"), "✕", false, () => this.#remove(index)),
      ]),
    ]);
  }

  #tool(label, glyph, disabled, onClick) {
    return el("button", {
      class: "btn btn--icon",
      type: "button",
      title: label,
      "aria-label": label,
      text: glyph,
      disabled,
      onClick,
    });
  }

  #label(record) {
    const host = record.host ? ` (${record.host}:${record.port ?? 22})` : "";
    return `${record.label || record.host || record.id}${host}`;
  }

  #add(id) {
    if (!id || this.#chain.includes(id)) return;
    this.#chain.push(id);
    this.#render();
    this.#onChange?.(this.value);
  }

  #remove(index) {
    this.#chain.splice(index, 1);
    this.#render();
    this.#onChange?.(this.value);
  }

  #move(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= this.#chain.length) return;
    const [id] = this.#chain.splice(index, 1);
    this.#chain.splice(to, 0, id);
    this.#render();
    this.#onChange?.(this.value);
  }

  #ensureEditor() {
    if (this.#editor) return this.#editor;
    this.#editor = new JumpHostEditorDialog({
      jumphippo: this.#jumphippo,
      openKeyFile: this.#openKeyFile,
      onSaved: async (record) => {
        const created = this.#creating;
        await this.refresh();
        if (record && record.id) {
          this.#selected = record.id; // keep the saved host focused
          // A newly created host joins the chain; an edit leaves it untouched.
          if (created && !this.#chain.includes(record.id)) {
            this.#chain.push(record.id);
            this.#onChange?.(this.value);
          }
          this.#render();
        }
      },
    });
    return this.#editor;
  }

  #openNew() {
    this.#creating = true;
    this.#ensureEditor().openCreate();
  }

  async #openEdit() {
    if (!this.#selected) return;
    const jump = await this.#jumphippo?.jumpHosts?.get?.(this.#selected);
    if (!jump) return;
    this.#creating = false;
    this.#ensureEditor().openEdit(jump);
  }

  // Delete the focused jump-host RECORD (not just remove it from this chain). A
  // light confirm (no type-to-confirm gate — it's a small, recreatable reference
  // item, and the store blocks deletion while a tunnel still uses it). On success,
  // announce so every open picker refreshes and prunes the dropped ref (this one
  // included, via its jumphippo:jumphosts-changed listener).
  #confirmDelete() {
    const id = this.#selected;
    if (!id) return;
    const record = this.#byId(id);
    const name = record ? this.#label(record) : id;
    PopupManager.confirmDelete({
      title: t("jumps.delete.title"),
      message: t("jumps.delete.message", { name }),
      requireText: false,
      onConfirm: async () => {
        let result;
        try {
          result = await this.#jumphippo?.jumpHosts?.delete?.(id);
        } catch (err) {
          PopupManager.notify({
            message: err?.message || t("jumps.delete.failed"),
          });
          return;
        }
        if (result && result.__hippoError) {
          PopupManager.notify({
            message:
              result.code === "IN_USE"
                ? t("jumps.delete.inUse")
                : result.message || t("jumps.delete.failed"),
          });
          return;
        }
        window.dispatchEvent(
          new CustomEvent("jumphippo:jumphosts-changed", { detail: { id } }),
        );
      },
    });
  }
}
