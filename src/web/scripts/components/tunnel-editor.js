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

// tunnel-editor.js — the definition form. Composes the top-level fields (name,
// local binding, destination, options) with a HopEditor for the terminating SSH
// server and a JumpHostEditor for the chain, assembles the create/update payload
// (honouring the write-only-secret contract), and drives inline validation.
//
// Validation is live but quiet until the first save attempt: `validate.js` (the
// renderer copy of the store's validator) runs on every change, and once the user
// has tried to save, keyed messages are painted via `applyFieldErrors` so they
// clear as fields are fixed. The store re-validates authoritatively; if it still
// rejects, its `errors` envelope is mapped the same way.

import { el } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { validateDefinition } from "../validate.js";
import { HopEditor } from "./hop-editor.js";
import { JumpHostEditor } from "./jump-host-editor.js";

const LOOPBACK = new Set(["", "127.0.0.1", "localhost", "::1"]);

function toPort(str) {
  const s = String(str).trim();
  if (s === "") return undefined;
  return Number(s);
}

function toInt(str) {
  const s = String(str).trim();
  if (s === "") return undefined;
  return Number(s);
}

export class TunnelEditor {
  #el;
  #form = blankForm();
  #controls = {}; // key → input element (for setValue)
  #sshEditor;
  #jumpEditor;
  #bindWarningEl;
  #errorBannerEl;
  #editingId = null;
  #showErrors = false;
  #dirty = false;
  #onSubmit;
  #onSaved;
  #onCancel;

  /**
   * @param {object} opts
   * @param {(payload: object, ctx: { id: string|null }) => Promise<object>} opts.onSubmit
   *        performs the store write and resolves to the store result (the record,
   *        or a `{ __hippoError, ... }` envelope). Success side-effects (list
   *        refresh, selection) are the parent's; this editor only maps errors.
   * @param {(record: object) => void} [opts.onSaved]  fires after a successful
   *        write with the stored record, so the parent can refresh + reselect.
   * @param {() => void} [opts.onCancel]
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ onSubmit, onSaved, onCancel, openKeyFile } = {}) {
    this.#onSubmit = onSubmit;
    this.#onSaved = onSaved;
    this.#onCancel = onCancel;
    this.#sshEditor = new HopEditor({
      pathPrefix: "sshServer",
      openKeyFile,
      onChange: () => this.#changed(),
    });
    this.#jumpEditor = new JumpHostEditor({
      openKeyFile,
      onChange: () => this.#changed(),
    });
    this.#el = this.#build();
    this.setValue(null);
  }

  get element() {
    return this.#el;
  }

  /** True once the user has edited anything since the last setValue. */
  isDirty() {
    return this.#dirty;
  }

  /** Load a definition for editing, or `null` to start a fresh one. */
  setValue(def) {
    const d = def && typeof def === "object" ? def : blankDefinition();
    this.#editingId = def && def.id ? def.id : null;
    this.#showErrors = false;
    this.#dirty = false;

    this.#form = {
      name: str(d.name),
      localPort: portStr(d.localPort),
      bindHost: str(d.bindHost),
      destHost: str(d.destination?.host),
      destPort: portStr(d.destination?.port),
      lingerMs:
        d.lingerMs === undefined || d.lingerMs === null
          ? ""
          : String(d.lingerMs),
      keepAlive: d.keepAlive === true,
      enabled: d.enabled !== false, // default armed-on-startup for a new tunnel
      autoReconnect: d.autoReconnect === true,
    };
    for (const [key, input] of Object.entries(this.#controls)) {
      if (input.type === "checkbox") input.checked = this.#form[key];
      else input.value = this.#form[key];
    }

    this.#sshEditor.setValue(d.sshServer);
    this.#jumpEditor.setValue(d.jumps);
    this.#updateBindWarning();
    this.#hideBanner();
    applyFieldErrors(this.#el, {});
  }

  /** Build the create/update payload from the current form state. */
  buildPayload() {
    const payload = {
      name: this.#form.name.trim(),
      localPort: toPort(this.#form.localPort),
      destination: {
        host: this.#form.destHost.trim(),
        port: toPort(this.#form.destPort),
      },
      sshServer: this.#sshEditor.getValue(),
      jumps: this.#jumpEditor.getValue(),
      keepAlive: this.#form.keepAlive,
      enabled: this.#form.enabled,
      autoReconnect: this.#form.autoReconnect,
    };
    const bindHost = this.#form.bindHost.trim();
    if (bindHost) payload.bindHost = bindHost;
    const linger = toInt(this.#form.lingerMs);
    if (linger !== undefined) payload.lingerMs = linger;
    return payload;
  }

  destroy() {
    this.#sshEditor.destroy();
    this.#jumpEditor.destroy();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  #build() {
    this.#bindWarningEl = el("p", {
      class: "editor-bind-warning",
      text: t("editor.bindHost.warning"),
      hidden: true,
    });
    this.#errorBannerEl = el("p", { class: "editor-error", hidden: true });

    return el(
      "form",
      {
        class: "tunnel-editor",
        onSubmit: (e) => {
          e.preventDefault();
          this.#save();
        },
      },
      [
        this.#section(t("editor.name"), [
          this.#textField(
            "name",
            t("editor.name"),
            "name",
            "e.g. Prod database",
          ),
          this.#checkField("enabled", t("editor.enabled")),
        ]),
        this.#section(t("editor.local"), [
          el("div", { class: "editor-row" }, [
            this.#textField(
              "localPort",
              t("editor.localPort"),
              "localPort",
              "8080",
              "number",
            ),
            this.#textField(
              "bindHost",
              t("editor.bindHost"),
              "bindHost",
              "127.0.0.1",
              "text",
              t("editor.bindHost.hint"),
            ),
          ]),
          this.#bindWarningEl,
        ]),
        this.#section(t("editor.destination"), [
          el("div", { class: "editor-row" }, [
            this.#textField(
              "destHost",
              t("editor.destination.host"),
              "destination.host",
              "db.internal",
            ),
            this.#textField(
              "destPort",
              t("editor.destination.port"),
              "destination.port",
              "5432",
              "number",
            ),
          ]),
        ]),
        this.#section(t("editor.sshServer"), [this.#sshEditor.element]),
        this.#section(t("editor.jumps"), [this.#jumpEditor.element]),
        this.#section(t("editor.options"), [
          this.#textField(
            "lingerMs",
            t("editor.linger"),
            "lingerMs",
            "10000",
            "number",
            t("editor.linger.hint"),
          ),
          this.#checkField("keepAlive", t("editor.keepAlive")),
          this.#checkField("autoReconnect", t("editor.autoReconnect")),
        ]),
        this.#errorBannerEl,
        el("div", { class: "editor-actions" }, [
          el("button", {
            class: "btn btn--secondary editor-cancel-btn",
            type: "button",
            text: t("editor.cancel"),
            onClick: () => this.#onCancel?.(),
          }),
          el("button", {
            class: "btn btn--primary editor-save-btn",
            type: "submit",
            text: t("editor.save"),
          }),
        ]),
      ],
    );
  }

  #section(title, children) {
    return el("section", { class: "editor-section" }, [
      el("h3", { class: "editor-section-title", text: title }),
      ...children,
    ]);
  }

  #textField(key, label, errorKey, placeholder, type = "text", hint) {
    const control = el("input", {
      class: `editor-input editor-input-${key}`,
      type,
      placeholder,
      "aria-label": label,
      value: this.#form[key],
      onInput: (e) => {
        this.#form[key] = e.target.value;
        if (key === "bindHost") this.#updateBindWarning();
        this.#changed();
      },
    });
    this.#controls[key] = control;
    return field({ label, control, errorKey, hint });
  }

  #checkField(key, label) {
    const control = el("input", {
      class: `editor-check-input editor-input-${key}`,
      type: "checkbox",
      "aria-label": label,
      checked: this.#form[key],
      onChange: (e) => {
        this.#form[key] = e.target.checked;
        this.#changed();
      },
    });
    this.#controls[key] = control;
    return el("label", { class: "editor-check" }, [
      control,
      el("span", { class: "editor-check-label", text: label }),
    ]);
  }

  // ── Behaviour ─────────────────────────────────────────────────────────────

  #changed() {
    this.#dirty = true;
    if (this.#showErrors) this.#revalidate();
    this.#hideBanner();
  }

  #updateBindWarning() {
    const beyondLoopback = !LOOPBACK.has(this.#form.bindHost.trim());
    this.#bindWarningEl.hidden = !beyondLoopback;
  }

  #revalidate() {
    const { errors } = validateDefinition(this.buildPayload());
    applyFieldErrors(this.#el, errors);
    return errors;
  }

  async #save() {
    this.#showErrors = true;
    const errors = this.#revalidate();
    if (Object.keys(errors).length > 0) return;

    const payload = this.buildPayload();
    let result;
    try {
      result = await this.#onSubmit?.(payload, { id: this.#editingId });
    } catch (err) {
      this.#showBanner(
        t("editor.saveError", { message: err?.message || String(err) }),
      );
      return;
    }

    if (result && result.__hippoError) {
      if (result.errors) applyFieldErrors(this.#el, result.errors);
      this.#showBanner(
        t("editor.saveError", { message: result.message || result.code || "" }),
      );
      return;
    }
    // Success: mark clean, then hand the stored record to the parent for the
    // follow-up (list refresh + reselect). Running onSaved last avoids re-entrancy
    // while this editor is still mid-save.
    this.#dirty = false;
    this.#onSaved?.(result);
  }

  #showBanner(message) {
    this.#errorBannerEl.textContent = message;
    this.#errorBannerEl.hidden = false;
  }

  #hideBanner() {
    this.#errorBannerEl.hidden = true;
  }
}

// ── Blank-state helpers ───────────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v : "";
}
function portStr(v) {
  return v === undefined || v === null ? "" : String(v);
}
function blankForm() {
  return {
    name: "",
    localPort: "",
    bindHost: "",
    destHost: "",
    destPort: "",
    lingerMs: "",
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
  };
}
function blankDefinition() {
  return {
    name: "",
    localPort: undefined,
    bindHost: "",
    destination: { host: "", port: undefined },
    sshServer: { host: "", port: 22, user: "", auth: [{ type: "agent" }] },
    jumps: [],
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
  };
}
