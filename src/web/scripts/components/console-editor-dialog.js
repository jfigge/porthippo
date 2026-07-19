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

// console-editor-dialog.js — create/edit a console (Feature 200) in a native
// <dialog>. A console is a simple reference record: a name, a target server
// (host[:port]), a credential, and an ordered jump-host chain — so this reuses the
// SAME credential + jump-host picker fields the tunnel editor uses (one pool of
// reusable records). On a successful store write it emits a global
// `jumphippo:consoles-changed` so the sidebar refreshes, and calls back
// `onSaved(record)` for the opener that launched it.

import { el } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { Dialog } from "../dialog.js";
import { parseTarget } from "../address.js";
import { validateConsole } from "../validate.js";
import { CredentialPickerField } from "./credential-picker-field.js";
import { JumpHostPickerField } from "./jump-host-picker-field.js";

export class ConsoleEditorDialog {
  #dialog;
  #jumphippo;
  #onSaved;

  #form = blankForm();
  #editingId = null;

  #nameInput;
  #targetInput;
  #credPicker;
  #jumpPicker;

  /**
   * @param {object} [opts]
   * @param {object} [opts.jumphippo]  IPC bridge (defaults to window.jumphippo)
   * @param {(defaultPath?: string) => Promise<object|null>} [opts.openKeyFile]  native
   *        key-file picker, threaded into the credential editor the pickers open
   * @param {(record: object) => void} [opts.onSaved]  the created/updated record
   */
  constructor({ jumphippo, openKeyFile, onSaved } = {}) {
    this.#jumphippo = jumphippo || window.jumphippo;
    this.#onSaved = onSaved;

    this.#credPicker = new CredentialPickerField({
      jumphippo: this.#jumphippo,
      openKeyFile,
      onChange: () => this.#dialog.clearError(),
    });
    this.#jumpPicker = new JumpHostPickerField({
      jumphippo: this.#jumphippo,
      openKeyFile,
      onChange: () => this.#dialog.clearError(),
    });

    this.#dialog = new Dialog({
      className: "console-dialog",
      title: t("consoles.newTitle"),
      onSubmit: () => this.#save(),
      onCancel: () => this.#dialog.close(),
    });
    this.#buildBody();
  }

  get element() {
    return this.#dialog.element;
  }

  /** Load both pickers' options; awaited before prefilling so setValue lands. */
  async #reloadPickers() {
    await Promise.all([this.#credPicker.load(), this.#jumpPicker.load()]);
  }

  /** Open a blank editor for a new console. */
  async openCreate() {
    this.#dialog.setTitle(t("consoles.newTitle"));
    await this.#reloadPickers();
    this.#load(null);
    this.#dialog.open();
  }

  /** Open the editor prefilled from an existing console. */
  async openEdit(def) {
    this.#dialog.setTitle(t("consoles.editTitle"));
    // Load the pickers' options FIRST so setValue can select the stored records
    // (a select rejects a value whose option isn't rendered yet).
    await this.#reloadPickers();
    this.#load(def);
    this.#dialog.open();
  }

  // ── Form state ────────────────────────────────────────────────────────────────

  #load(def) {
    const d = def && typeof def === "object" ? def : {};
    this.#editingId = d.id || null;
    this.#form = { name: str(d.name), target: reconstructTarget(d) };
    this.#nameInput.value = this.#form.name;
    this.#targetInput.value = this.#form.target;
    this.#credPicker.setValue(d.credentialId || "");
    this.#jumpPicker.setValue(
      Array.isArray(d.jumpHostIds) ? d.jumpHostIds : [],
    );
    applyFieldErrors(this.#dialog.body, {});
    this.#dialog.clearError();
  }

  /** Assemble the store payload from the form + live pickers. */
  buildPayload() {
    const payload = {
      name: this.#form.name.trim(),
      credentialId: this.#credPicker.value || "",
      jumpHostIds: this.#jumpPicker.value || [],
    };
    const target = parseTarget(this.#form.target);
    if (!target.error) {
      payload.sshHost = target.host;
      if (target.port) payload.sshPort = target.port;
    }
    return payload;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  #buildBody() {
    this.#nameInput = el("input", {
      class: "dialog-input",
      type: "text",
      placeholder: t("consoles.name.placeholder"),
      "aria-label": t("editor.name"),
      "data-autofocus": true,
      onInput: (e) => (this.#form.name = e.target.value),
    });

    this.#targetInput = el("input", {
      class: "dialog-input",
      type: "text",
      placeholder: t("editor.targetServer.placeholder"),
      "aria-label": t("editor.targetServer"),
      onInput: (e) => (this.#form.target = e.target.value),
    });

    this.#dialog.body.append(
      field({
        label: t("editor.name"),
        control: this.#nameInput,
        errorKey: "name",
      }),
      field({
        label: t("editor.targetServer"),
        control: this.#targetInput,
        errorKey: "sshHost",
        hint: t("editor.targetServer.hint"),
      }),
      this.#credPicker.element,
      this.#jumpPicker.element,
    );
  }

  // ── Save ──────────────────────────────────────────────────────────────────────

  #computeErrors() {
    const payload = this.buildPayload();
    const errors = { ...validateConsole(payload).errors };
    // Overlay the field-specific target-parse message so a bad port reads as a
    // range error (not the generic "required" validateConsole emits when sshHost
    // ends up unset).
    const target = parseTarget(this.#form.target);
    if (target.error === "empty") errors.sshHost = t("consoles.targetRequired");
    else if (target.error === "port_range")
      errors.sshHost = t("editor.address.portRange");
    return { payload, errors };
  }

  async #save() {
    const { payload, errors } = this.#computeErrors();
    applyFieldErrors(this.#dialog.body, errors);
    if (Object.keys(errors).length > 0) return;

    let result;
    try {
      result = this.#editingId
        ? await this.#jumphippo.consoles.update(this.#editingId, payload)
        : await this.#jumphippo.consoles.create(payload);
    } catch (err) {
      this.#dialog.showError(
        t("editor.saveError", { message: err?.message || String(err) }),
      );
      return;
    }

    if (result && result.__hippoError) {
      if (result.errors) applyFieldErrors(this.#dialog.body, result.errors);
      this.#dialog.showError(
        t("editor.saveError", { message: result.message || result.code || "" }),
      );
      return;
    }

    this.#dialog.close();
    window.dispatchEvent(
      new CustomEvent("jumphippo:consoles-changed", {
        detail: { id: result && result.id },
      }),
    );
    this.#onSaved?.(result);
  }
}

// ── Blank-state helpers ─────────────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v : "";
}

function blankForm() {
  return { name: "", target: "" };
}

/** Rebuild the Target-server field string from a stored console (drops :22). */
function reconstructTarget(def) {
  const host = str(def.sshHost);
  if (!host) return "";
  const port = def.sshPort;
  return Number.isInteger(port) && port !== 22 ? `${host}:${port}` : host;
}
