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

// credential-picker-field.js — choose a reusable credential by id. A labelled
// `.field` (so validation errors land against `credentialId`) wrapping a <select>
// of credentials plus inline "New…" / "Edit" actions that open the
// CredentialEditorDialog. It reloads whenever a credential changes anywhere
// (`jumphippo:credentials-changed`), preserving the current selection, and reports
// the chosen id up via the `onChange` constructor callback.

import { el, clear } from "../dom.js";
import { field } from "../field.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { PopupManager } from "../popup-manager.js";
import { CredentialEditorDialog } from "./credential-editor-dialog.js";
import { credentialNeedsSecret } from "./credential-status.js";

export class CredentialPickerField {
  #el;
  #select;
  #editBtn;
  #deleteBtn;
  #jumphippo;
  #openKeyFile;
  #onChange;
  #errorKey;
  #credentials = [];
  #value = "";
  #editor = null;
  #onCredsChanged;

  /**
   * @param {object} [opts]
   * @param {object} [opts.jumphippo]  IPC bridge (defaults to window.jumphippo)
   * @param {(id: string) => void} [opts.onChange]
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   * @param {string} [opts.label]
   * @param {string} [opts.errorKey]  dotted validation path (default "credentialId")
   */
  constructor({ jumphippo, onChange, openKeyFile, label, errorKey } = {}) {
    this.#jumphippo = jumphippo || window.jumphippo;
    this.#openKeyFile = openKeyFile;
    this.#onChange = onChange;
    this.#errorKey = errorKey || "credentialId";
    this.#el = this.#build(label || t("editor.credential"));

    this.#onCredsChanged = () => this.refresh();
    window.addEventListener(
      "jumphippo:credentials-changed",
      this.#onCredsChanged,
    );
  }

  get element() {
    return this.#el;
  }

  /** The selected credential id (empty string when none). */
  get value() {
    return this.#value;
  }

  /** Select a credential by id (no-op if it isn't in the loaded list). */
  setValue(id) {
    this.#value = typeof id === "string" ? id : "";
    this.#select.value = this.#value;
    // A stale id the <select> couldn't take falls back to the placeholder.
    if (this.#select.value !== this.#value) this.#value = "";
    this.#syncButtons();
  }

  /** Load the credential list and render the options. Call once after mount. */
  async load() {
    await this.refresh();
  }

  /** Reload credentials, preserving the current selection where still valid. */
  async refresh() {
    const list = (await this.#jumphippo?.credentials?.list?.()) || [];
    this.#credentials = Array.isArray(list) ? list : [];
    this.#renderOptions();
    this.setValue(this.#value); // re-assert (drops a now-deleted selection)
  }

  destroy() {
    window.removeEventListener(
      "jumphippo:credentials-changed",
      this.#onCredsChanged,
    );
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #build(label) {
    this.#select = el("select", {
      class: "dialog-input cred-picker-select",
      "aria-label": label,
      onChange: (e) => {
        this.#value = e.target.value;
        this.#syncButtons();
        this.#onChange?.(this.#value);
      },
    });
    const newBtn = this.#iconBtn(
      "cred-picker-new",
      t("cred.new"),
      icons.filePlus(),
      () => this.#openNew(),
    );
    this.#editBtn = this.#iconBtn(
      "cred-picker-edit",
      t("common.edit"),
      icons.edit(),
      () => this.#openEdit(),
      true,
    );
    this.#deleteBtn = this.#iconBtn(
      "cred-picker-delete",
      t("cred.delete"),
      icons.trash(),
      () => this.#confirmDelete(),
      true,
    );
    const control = el("div", { class: "picker-row" }, [
      this.#select,
      newBtn,
      this.#editBtn,
      this.#deleteBtn,
    ]);
    this.#renderOptions();
    return field({ label, control, errorKey: this.#errorKey });
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

  #renderOptions() {
    clear(this.#select);
    this.#select.append(
      el("option", { value: "", text: t("cred.choose") }),
      ...this.#credentials.map((c) => {
        // A password credential imported without its secret (Feature 120) can't
        // authenticate until the password is re-entered — flag it in the list.
        const label = c.label || c.id;
        const text = credentialNeedsSecret(c)
          ? `${label} — ${t("cred.needsSecret")}`
          : label;
        return el("option", { value: c.id, text });
      }),
    );
    this.#select.value = this.#value;
  }

  #syncButtons() {
    this.#editBtn.disabled = !this.#value;
    this.#deleteBtn.disabled = !this.#value;
  }

  #ensureEditor() {
    if (this.#editor) return this.#editor;
    this.#editor = new CredentialEditorDialog({
      jumphippo: this.#jumphippo,
      openKeyFile: this.#openKeyFile,
      onSaved: async (record) => {
        await this.refresh();
        if (record && record.id) {
          this.setValue(record.id);
          this.#onChange?.(this.#value);
        }
      },
    });
    return this.#editor;
  }

  #openNew() {
    this.#ensureEditor().openCreate();
  }

  async #openEdit() {
    if (!this.#value) return;
    const cred = await this.#jumphippo?.credentials?.get?.(this.#value);
    if (cred) this.#ensureEditor().openEdit(cred);
  }

  // Delete the selected credential RECORD. A light confirm (no type-to-confirm
  // gate — recreatable, and the store blocks deletion while a tunnel/jump host
  // still uses it). On success, announce so every open picker refreshes and drops
  // the now-deleted selection (this one via its jumphippo:credentials-changed
  // listener).
  #confirmDelete() {
    const id = this.#value;
    if (!id) return;
    const cred = this.#credentials.find((c) => c.id === id);
    const name = (cred && (cred.label || cred.id)) || id;
    PopupManager.confirmDelete({
      title: t("cred.delete.title"),
      message: t("cred.delete.message", { name }),
      requireText: false,
      onConfirm: async () => {
        let result;
        try {
          result = await this.#jumphippo?.credentials?.delete?.(id);
        } catch (err) {
          PopupManager.notify({
            message: err?.message || t("cred.delete.failed"),
          });
          return;
        }
        if (result && result.__hippoError) {
          PopupManager.notify({
            message:
              result.code === "IN_USE"
                ? t("cred.delete.inUse")
                : result.message || t("cred.delete.failed"),
          });
          return;
        }
        window.dispatchEvent(
          new CustomEvent("jumphippo:credentials-changed", { detail: { id } }),
        );
      },
    });
  }
}
