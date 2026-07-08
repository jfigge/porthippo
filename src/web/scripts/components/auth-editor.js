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

// auth-editor.js — the per-hop authentication editor.
//
// A hop's `auth` is an ORDERED array of methods the engine tries in turn, so this
// is an add/remove/reorder list (minimum one row), each row a discriminated-union
// editor keyed on `type` (agent | key | password) that reveals only that type's
// fields. Secrets are write-only: a loaded entry arrives as `hasSecret` with no
// value; the field shows "•••• set" and only sends a new secret when the user
// types one (else it re-sends `hasSecret:true` to retain the stored ciphertext).
//
// Reports its value up via the `onChange` constructor callback (app-wide changes
// are the TunnelEditor's job, not this widget's). Error display is centralized:
// each control lives in a `field()` tagged with its dotted path, which the
// TunnelEditor fills in from validation.

import { el, clear } from "../dom.js";
import { field } from "../field.js";
import { t } from "../i18n.js";
import { AUTH_TYPES, secretFieldForAuthType } from "../validate.js";

let uid = 0;
const nextId = () => `auth-${++uid}`;

export class AuthEditor {
  #el;
  #listEl;
  #rows = []; // { type, keyPath, secretValue, loadedType, hadSecret }
  #pathPrefix; // dotted path of the hop's `auth`, e.g. "sshServer.auth"
  #onChange;
  #openKeyFile;

  /**
   * @param {object} opts
   * @param {(auth: object[]) => void} [opts.onChange]
   * @param {string} [opts.pathPrefix]  the hop's auth path (for error keys)
   * @param {() => Promise<string|null>} [opts.openKeyFile]  native key picker
   *        (injectable for tests; defaults to the preload dialog bridge)
   */
  constructor({ onChange, pathPrefix = "sshServer.auth", openKeyFile } = {}) {
    this.#onChange = onChange;
    this.#pathPrefix = pathPrefix;
    this.#openKeyFile =
      openKeyFile || (() => window.porthippo?.dialog?.openKeyFile?.());
    this.#el = this.#build();
    this.#rows = [this.#blankRow()];
    this.#renderList();
  }

  get element() {
    return this.#el;
  }

  /** Replace the edited methods (min one row). Does not fire onChange. */
  setValue(authArray) {
    const list =
      Array.isArray(authArray) && authArray.length ? authArray : [null];
    this.#rows = list.map((entry) => this.#rowFromEntry(entry));
    this.#renderList();
  }

  /** The current `auth[]` array in on-the-wire form (write-only secrets). */
  getValue() {
    return this.#rows.map((row) => this.#rowToEntry(row));
  }

  /** Update the dotted path prefix (e.g. after a jump host is reordered). */
  setPathPrefix(prefix) {
    if (prefix === this.#pathPrefix) return;
    this.#pathPrefix = prefix;
    this.#renderList();
  }

  destroy() {
    // No window-level listeners to remove; present for lifecycle symmetry.
  }

  // ── Model helpers ─────────────────────────────────────────────────────────

  #blankRow() {
    return {
      type: "agent",
      keyPath: "",
      secretValue: "",
      loadedType: null,
      hadSecret: false,
    };
  }

  #rowFromEntry(entry) {
    const e = entry && typeof entry === "object" ? entry : {};
    return {
      type: AUTH_TYPES.includes(e.type) ? e.type : "agent",
      keyPath: typeof e.privateKeyPath === "string" ? e.privateKeyPath : "",
      secretValue: "",
      loadedType: AUTH_TYPES.includes(e.type) ? e.type : null,
      hadSecret: e.hasSecret === true,
    };
  }

  #rowToEntry(row) {
    const entry = { type: row.type };
    if (row.type === "key") entry.privateKeyPath = row.keyPath.trim();

    const secretField = secretFieldForAuthType(row.type);
    if (secretField) {
      if (row.secretValue.length > 0) {
        entry[secretField] = row.secretValue; // a freshly typed secret
      } else if (this.#retainable(row)) {
        entry.hasSecret = true; // keep the stored ciphertext untouched
      }
    }
    return entry;
  }

  /** True when the row still points at its loaded type and had a stored secret. */
  #retainable(row) {
    return row.type === row.loadedType && row.hadSecret;
  }

  #emit() {
    this.#onChange?.(this.getValue());
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  #build() {
    this.#listEl = el("div", { class: "auth-list" });
    return el("div", { class: "auth-editor" }, [
      el("div", { class: "auth-header" }, [
        el("span", { class: "auth-header-title", text: t("auth.title") }),
        el("button", {
          class: "btn btn--ghost auth-add-btn",
          type: "button",
          text: t("auth.add"),
          onClick: () => this.#addRow(),
        }),
      ]),
      // Section-level error slot (e.g. "at least one auth method is required").
      el(
        "div",
        {
          class: "field auth-section-field",
          dataset: { errorKey: this.#pathPrefix },
        },
        [el("p", { class: "field-error", hidden: true, role: "alert" })],
      ),
      this.#listEl,
    ]);
  }

  #renderList() {
    // Keep the section-level error field's key in sync with the current prefix.
    const sectionField = this.#el.querySelector(".auth-section-field");
    if (sectionField) sectionField.dataset.errorKey = this.#pathPrefix;

    clear(this.#listEl);
    this.#rows.forEach((row, i) =>
      this.#listEl.appendChild(this.#renderRow(row, i)),
    );
  }

  #renderRow(row, index) {
    const prefix = `${this.#pathPrefix}[${index}]`;
    const canRemove = this.#rows.length > 1;

    const typeSelect = el(
      "select",
      {
        class: "auth-type-select",
        "aria-label": t("auth.type"),
        onChange: (e) => this.#changeType(index, e.target.value),
      },
      AUTH_TYPES.map((type) =>
        el("option", {
          value: type,
          text: t(`auth.type.${type}`),
          selected: type === row.type,
        }),
      ),
    );

    return el("div", { class: "auth-method" }, [
      el("div", { class: "auth-method-head" }, [
        el("span", {
          class: "auth-method-title",
          text: t("auth.method", { n: index + 1 }),
        }),
        el("div", { class: "auth-method-tools" }, [
          this.#toolBtn(t("auth.moveUp"), "↑", index === 0, () =>
            this.#move(index, -1),
          ),
          this.#toolBtn(
            t("auth.moveDown"),
            "↓",
            index === this.#rows.length - 1,
            () => this.#move(index, 1),
          ),
          this.#toolBtn(
            t("auth.remove"),
            "✕",
            !canRemove,
            () => this.#remove(index),
            "auth-remove-btn",
          ),
        ]),
      ]),
      field({
        label: t("auth.type"),
        control: typeSelect,
        errorKey: `${prefix}.type`,
      }),
      ...this.#renderTypeFields(row, index, prefix),
    ]);
  }

  #renderTypeFields(row, index, prefix) {
    if (row.type === "agent") {
      return [el("p", { class: "auth-agent-hint", text: t("auth.agentHint") })];
    }

    const fields = [];

    if (row.type === "key") {
      const pathInput = el("input", {
        class: "auth-input auth-keypath-input",
        type: "text",
        value: row.keyPath,
        placeholder: t("auth.keyPath.placeholder"),
        "aria-label": t("auth.keyPath"),
        onInput: (e) => {
          row.keyPath = e.target.value;
          this.#emit();
        },
      });
      const browseBtn = el("button", {
        class: "btn btn--secondary auth-browse-btn",
        type: "button",
        text: t("auth.browse"),
        onClick: () => this.#browse(index),
      });
      fields.push(
        field({
          label: t("auth.keyPath"),
          control: el("div", { class: "auth-keypath-row" }, [
            pathInput,
            browseBtn,
          ]),
          errorKey: `${prefix}.privateKeyPath`,
        }),
      );
    }

    const secretField = secretFieldForAuthType(row.type);
    if (secretField) {
      fields.push(this.#renderSecretField(row, prefix, secretField));
    }
    return fields;
  }

  #renderSecretField(row, prefix, secretField) {
    const id = nextId();
    const retainable = this.#retainable(row);
    const status = el("span", {
      class: "auth-secret-status",
      text: t("auth.secretSet"),
      hidden: !(retainable && row.secretValue.length === 0),
    });
    const input = el("input", {
      id,
      class: "auth-input auth-secret-input",
      type: "password",
      value: row.secretValue,
      autocomplete: "new-password",
      placeholder: retainable ? t("auth.secretKeep") : "",
      "aria-label": t(`auth.${secretField}`),
      onInput: (e) => {
        row.secretValue = e.target.value;
        status.hidden = !(retainable && row.secretValue.length === 0);
        this.#emit();
      },
    });
    return field({
      label: t(`auth.${secretField}`),
      control: el("div", { class: "auth-secret-row" }, [input, status]),
      labelFor: id,
      errorKey: `${prefix}.${secretField}`,
    });
  }

  #toolBtn(label, glyph, disabled, onClick, extraClass = "") {
    return el("button", {
      class: `btn btn--icon auth-tool-btn ${extraClass}`.trim(),
      type: "button",
      title: label,
      "aria-label": label,
      text: glyph,
      disabled,
      onClick,
    });
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  #changeType(index, type) {
    const row = this.#rows[index];
    if (!AUTH_TYPES.includes(type) || row.type === type) return;
    row.type = type;
    row.secretValue = ""; // a password isn't a passphrase — never carry across
    this.#renderList();
    this.#emit();
  }

  #addRow() {
    this.#rows.push(this.#blankRow());
    this.#renderList();
    this.#emit();
  }

  #remove(index) {
    if (this.#rows.length <= 1) return;
    this.#rows.splice(index, 1);
    this.#renderList();
    this.#emit();
  }

  #move(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= this.#rows.length) return;
    const [row] = this.#rows.splice(index, 1);
    this.#rows.splice(to, 0, row);
    this.#renderList();
    this.#emit();
  }

  async #browse(index) {
    const path = await this.#openKeyFile();
    if (!path) return;
    this.#rows[index].keyPath = path;
    this.#renderList();
    this.#emit();
  }
}
