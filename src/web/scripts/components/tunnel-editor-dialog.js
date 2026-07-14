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

// tunnel-editor-dialog.js — create/edit a tunnel in a native <dialog>. The common
// case shows ~four fields (name, destination host + port, local port, credential);
// everything else — local bind address, SSH-server override, jump-host chain,
// options — lives in a collapsed native <details> so the SSH server and local host
// only appear when a user goes looking for them.
//
// Validation is live-but-quiet until the first save attempt (mirroring the old
// inline editor): validateDefinition drives inline field errors; two soft warnings
// (a privileged local port, a port already claimed by another tunnel) never block
// the save — they surface conditions the engine would otherwise only reveal at arm
// time. The store re-validates authoritatively.

import { el } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { Dialog } from "../dialog.js";
import { validateDefinition } from "../validate.js";
import { CredentialPickerField } from "./credential-picker-field.js";
import { JumpHostPickerField } from "./jump-host-picker-field.js";

const LOOPBACK = new Set(["", "127.0.0.1", "localhost", "::1"]);
const PRIVILEGED_PORT = 1024;

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

export class TunnelEditorDialog {
  #dialog;
  #porthippo;
  #onSubmit;
  #onSaved;

  #form = blankForm();
  #controls = {};
  #credPicker;
  #jumpPicker;
  #detailsEl;
  #bindWarningEl;
  #portWarningEl;
  #editingId = null;
  #showErrors = false;
  #existing = []; // other tunnels, for the local-port conflict warning

  /**
   * @param {object} opts
   * @param {object} [opts.porthippo]  IPC bridge (defaults to window.porthippo)
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   * @param {(payload: object, ctx: { id: string|null }) => Promise<object>} opts.onSubmit
   *        performs the store write and resolves to the record or a `{ __hippoError }`.
   * @param {(record: object) => void} [opts.onSaved]  fires after a successful write.
   */
  constructor({ porthippo, openKeyFile, onSubmit, onSaved } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#onSubmit = onSubmit;
    this.#onSaved = onSaved;

    this.#credPicker = new CredentialPickerField({
      porthippo: this.#porthippo,
      openKeyFile,
      label: t("editor.credential"),
      onChange: (id) => {
        this.#form.credentialId = id;
        this.#changed();
      },
    });
    this.#jumpPicker = new JumpHostPickerField({
      porthippo: this.#porthippo,
      openKeyFile,
      onChange: () => this.#changed(),
    });

    this.#dialog = new Dialog({
      className: "tunnel-dialog",
      title: t("editor.newTitle"),
      onSubmit: () => this.#save(),
      onCancel: () => this.#dialog.close(),
    });
    this.#buildBody();
  }

  get element() {
    return this.#dialog.element;
  }

  /** Open a blank editor for a new tunnel. */
  async openCreate() {
    await this.#load(null);
    this.#dialog.setTitle(t("editor.newTitle"));
    this.#dialog.open();
  }

  /** Open the editor prefilled from an existing definition. */
  async openEdit(def) {
    await this.#load(def);
    this.#dialog.setTitle(t("editor.editTitle"));
    this.#dialog.open();
  }

  // ── Form state ──────────────────────────────────────────────────────────────

  async #load(def) {
    const d = def && typeof def === "object" ? def : {};
    this.#editingId = d.id || null;
    this.#showErrors = false;

    this.#form = {
      name: str(d.name),
      localPort: portStr(d.localPort),
      bindHost: str(d.bindHost),
      destHost: str(d.destination?.host),
      destPort: portStr(d.destination?.port),
      sshHost: str(d.sshHost),
      sshPort: portStr(d.sshPort),
      credentialId: str(d.credentialId),
      jumpHostIds: Array.isArray(d.jumpHostIds) ? d.jumpHostIds : [],
      lingerMs:
        d.lingerMs === undefined || d.lingerMs === null
          ? ""
          : String(d.lingerMs),
      keepAlive: d.keepAlive === true,
      enabled: d.enabled !== false, // default arm-on-startup for a new tunnel
      autoReconnect: d.autoReconnect === true,
    };
    for (const [key, input] of Object.entries(this.#controls)) {
      if (input.type === "checkbox") input.checked = this.#form[key];
      else input.value = this.#form[key];
    }

    // Load the reference pickers, then apply the stored selection.
    await Promise.all([this.#credPicker.load(), this.#jumpPicker.load()]);
    this.#credPicker.setValue(this.#form.credentialId);
    this.#jumpPicker.setValue(this.#form.jumpHostIds);

    // Existing tunnels for the local-port conflict check.
    this.#existing = (await this.#porthippo?.tunnels?.list?.()) || [];

    // Reveal Advanced up front when the tunnel actually uses any advanced field.
    this.#detailsEl.open = this.#usesAdvanced();

    this.#updateBindWarning();
    this.#updatePortWarning();
    this.#dialog.clearError();
    applyFieldErrors(this.#dialog.body, {});
  }

  #usesAdvanced() {
    return Boolean(
      this.#form.bindHost.trim() ||
      this.#form.sshHost.trim() ||
      this.#form.sshPort.trim() ||
      this.#form.jumpHostIds.length ||
      this.#form.keepAlive ||
      this.#form.autoReconnect ||
      this.#form.lingerMs !== "",
    );
  }

  buildPayload() {
    const payload = {
      name: this.#form.name.trim(),
      localPort: toPort(this.#form.localPort),
      destination: {
        host: this.#form.destHost.trim(),
        port: toPort(this.#form.destPort),
      },
      // Read the live picker (like jumpHostIds) — it drops a since-deleted id to
      // "", whereas #form.credentialId can retain a stale id the picker rejected.
      credentialId: this.#credPicker.value,
      jumpHostIds: this.#jumpPicker.value,
      keepAlive: this.#form.keepAlive,
      enabled: this.#form.enabled,
      autoReconnect: this.#form.autoReconnect,
    };
    const bindHost = this.#form.bindHost.trim();
    if (bindHost) payload.bindHost = bindHost;
    const sshHost = this.#form.sshHost.trim();
    if (sshHost) payload.sshHost = sshHost;
    const sshPort = toPort(this.#form.sshPort);
    if (sshPort !== undefined) payload.sshPort = sshPort;
    const linger = toInt(this.#form.lingerMs);
    if (linger !== undefined) payload.lingerMs = linger;
    return payload;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  #buildBody() {
    this.#bindWarningEl = el("p", {
      class: "editor-bind-warning",
      text: t("editor.bindHost.warning"),
      hidden: true,
    });
    this.#portWarningEl = el("p", {
      class: "editor-port-warning",
      hidden: true,
    });

    this.#detailsEl = el("details", { class: "editor-advanced" }, [
      el("summary", {
        class: "editor-advanced-summary",
        text: t("editor.advanced"),
      }),
      this.#section([
        field({
          label: t("editor.bindHost"),
          control: this.#input("bindHost", "127.0.0.1", "text"),
          errorKey: "bindHost",
          hint: t("editor.bindHost.hint"),
        }),
        this.#bindWarningEl,
      ]),
      this.#section([
        el("div", { class: "editor-row" }, [
          field({
            label: t("editor.sshHost"),
            control: this.#input(
              "sshHost",
              t("editor.sshHost.placeholder"),
              "text",
            ),
            errorKey: "sshHost",
            hint: t("editor.sshHost.hint"),
          }),
          field({
            label: t("editor.sshPort"),
            control: this.#input("sshPort", "22", "number"),
            errorKey: "sshPort",
          }),
        ]),
      ]),
      this.#jumpPicker.element,
      this.#section([
        field({
          label: t("editor.linger"),
          control: this.#input("lingerMs", "10000", "number"),
          errorKey: "lingerMs",
          hint: t("editor.linger.hint"),
        }),
        this.#check("enabled", t("editor.enabled")),
        this.#check("keepAlive", t("editor.keepAlive")),
        this.#check("autoReconnect", t("editor.autoReconnect")),
      ]),
    ]);

    this.#dialog.body.append(
      field({
        label: t("editor.name"),
        control: this.#input("name", "e.g. Prod database", "text"),
        errorKey: "name",
      }),
      field({
        label: t("editor.destination.host"),
        control: this.#input("destHost", "db.internal", "text"),
        errorKey: "destination.host",
      }),
      this.#section([
        el("div", { class: "editor-row" }, [
          field({
            label: t("editor.destination.port"),
            control: this.#input("destPort", "5432", "number"),
            errorKey: "destination.port",
          }),
          field({
            label: t("editor.localPort"),
            control: this.#input("localPort", "5432", "number"),
            errorKey: "localPort",
          }),
        ]),
        this.#portWarningEl,
      ]),
      this.#credPicker.element,
      this.#detailsEl,
    );
  }

  #section(children) {
    return el("div", { class: "editor-block" }, children);
  }

  #input(key, placeholder, type) {
    const control = el("input", {
      class: `dialog-input editor-input-${key}`,
      type,
      placeholder,
      value: this.#form[key],
      onInput: (e) => {
        this.#form[key] = e.target.value;
        if (key === "bindHost") this.#updateBindWarning();
        if (key === "localPort") this.#updatePortWarning();
        this.#changed();
      },
    });
    this.#controls[key] = control;
    return control;
  }

  #check(key, label) {
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
    if (this.#showErrors) this.#revalidate();
    this.#dialog.clearError();
  }

  #updateBindWarning() {
    this.#bindWarningEl.hidden = LOOPBACK.has(this.#form.bindHost.trim());
  }

  #updatePortWarning() {
    const port = toPort(this.#form.localPort);
    let message = "";
    if (Number.isInteger(port)) {
      const clash = this.#existing.find(
        (d) => d && d.id !== this.#editingId && d.localPort === port,
      );
      if (clash) {
        message = t("editor.localPort.conflict", {
          port,
          name: clash.name || t("def.unnamed"),
        });
      } else if (port < PRIVILEGED_PORT) {
        message = t("editor.localPort.privileged");
      }
    }
    this.#portWarningEl.textContent = message;
    this.#portWarningEl.hidden = message === "";
  }

  #revalidate() {
    const { errors } = validateDefinition(this.buildPayload());
    applyFieldErrors(this.#dialog.body, errors);
    return errors;
  }

  async #save() {
    this.#showErrors = true;
    const errors = this.#revalidate();
    if (Object.keys(errors).length > 0) {
      // Open Advanced if the only remaining problems live inside it.
      if (this.#hasAdvancedError(errors)) this.#detailsEl.open = true;
      return;
    }

    let result;
    try {
      result = await this.#onSubmit?.(this.buildPayload(), {
        id: this.#editingId,
      });
    } catch (err) {
      this.#dialog.showError(
        t("editor.saveError", { message: err?.message || String(err) }),
      );
      return;
    }

    if (result && result.__hippoError) {
      if (result.errors) {
        applyFieldErrors(this.#dialog.body, result.errors);
        if (this.#hasAdvancedError(result.errors)) this.#detailsEl.open = true;
      }
      this.#dialog.showError(
        t("editor.saveError", { message: result.message || result.code || "" }),
      );
      return;
    }

    this.#dialog.close();
    this.#onSaved?.(result);
  }

  #hasAdvancedError(errors) {
    return Object.keys(errors).some(
      (k) =>
        k === "bindHost" ||
        k === "sshHost" ||
        k === "sshPort" ||
        k === "lingerMs" ||
        k.startsWith("jumpHostIds"),
    );
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
    sshHost: "",
    sshPort: "",
    credentialId: "",
    jumpHostIds: [],
    lingerMs: "",
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
  };
}
