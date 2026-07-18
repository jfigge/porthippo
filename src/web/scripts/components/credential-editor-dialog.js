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

// credential-editor-dialog.js — create/edit a reusable SSH credential in a native
// <dialog>. A credential carries a single auth method (agent | key | password);
// the type-dependent fields (key path, secret) reveal only for the chosen type.
//
// Secrets are write-only: an edited credential arrives with `hasSecret` and no
// value, the secret field shows "•••• set", and only a freshly-typed value is
// sent (else `hasSecret: true` re-affirms the stored ciphertext). On a successful
// store write it emits a global `jumphippo:credentials-changed` so open pickers
// refresh, and calls back `onSaved(record)` for the opener that launched it.

import { el, clear } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { can } from "../build-info.js";
import { Dialog } from "../dialog.js";
import {
  AUTH_TYPES,
  secretFieldForAuthType,
  validateCredential,
} from "../validate.js";

let uid = 0;
const nextId = () => `cred-secret-${++uid}`;

export class CredentialEditorDialog {
  #dialog;
  #jumphippo;
  #openKeyFile;
  #keyStatus;
  #onSaved;

  #form = blankForm();
  #editingId = null;
  #loadedType = null;
  #hadSecret = false;

  #labelInput;
  #userInput;
  #typeSelect;
  #typeFieldsEl;

  /**
   * @param {object} [opts]
   * @param {object} [opts.jumphippo]  IPC bridge (defaults to window.jumphippo)
   * @param {() => Promise<string|{path:string,remembered?:boolean}|null>} [opts.openKeyFile]
   * @param {(path: string) => Promise<{needsRepick:boolean}>} [opts.keyStatus]
   *        query whether a stored key path needs re-picking (Feature 190, MAS).
   * @param {(record: object) => void} [opts.onSaved]  the created/updated record
   */
  constructor({ jumphippo, openKeyFile, keyStatus, onSaved } = {}) {
    this.#jumphippo = jumphippo || window.jumphippo;
    this.#openKeyFile =
      openKeyFile ||
      ((defaultPath) => this.#jumphippo?.dialog?.openKeyFile?.(defaultPath));
    this.#keyStatus =
      keyStatus || ((path) => this.#jumphippo?.dialog?.keyStatus?.(path));
    this.#onSaved = onSaved;

    this.#dialog = new Dialog({
      className: "credential-dialog",
      title: t("cred.newTitle"),
      onSubmit: () => this.#save(),
      onCancel: () => this.#dialog.close(),
    });
    this.#buildBody();
  }

  get element() {
    return this.#dialog.element;
  }

  /** Open a blank editor for a new credential. */
  openCreate() {
    this.#load(null);
    this.#dialog.setTitle(t("cred.newTitle"));
    this.#dialog.open();
  }

  /** Open the editor prefilled from an existing (secret-stripped) credential. */
  openEdit(cred) {
    this.#load(cred);
    this.#dialog.setTitle(t("cred.editTitle"));
    this.#dialog.open();
  }

  // ── Form state ──────────────────────────────────────────────────────────────

  #load(cred) {
    const c = cred && typeof cred === "object" ? cred : {};
    this.#editingId = c.id || null;
    this.#loadedType = AUTH_TYPES.includes(c.authType) ? c.authType : null;
    this.#hadSecret = c.hasSecret === true;
    this.#form = {
      label: str(c.label),
      user: str(c.user),
      authType: AUTH_TYPES.includes(c.authType)
        ? c.authType
        : this.#defaultAuthType(),
      keyPath: str(c.keyPath),
      secretValue: "",
      // Feature 190: set true right after a Browse that stored a durable
      // security-scoped bookmark (MAS), to reassure the user the key survives a
      // relaunch. Never known from a loaded credential — the renderer never sees
      // the bookmark — so it always starts false.
      keyRemembered: false,
      // Feature 190: set true when the stored key path has NO bookmark in a MAS
      // build (so it can't be read after a relaunch) — resolved async against main
      // in #refreshKeyStatus, which then shows the "re-pick this key" warning.
      keyNeedsRepick: false,
    };
    this.#labelInput.value = this.#form.label;
    this.#userInput.value = this.#form.user;
    // Repopulate the type options first — the available set depends on the loaded
    // credential (a store build without ssh-agent still shows "agent" when the
    // credential being edited uses it, so it displays with a warning).
    this.#populateTypeOptions();
    this.#typeSelect.value = this.#form.authType;
    this.#renderTypeFields();
    applyFieldErrors(this.#dialog.body, {});
    this.#dialog.clearError();
    // A stored key credential may predate Feature 190 (or have a typed path), so it
    // has no bookmark and can't be read in the MAS sandbox. Check async and, if so,
    // surface the "re-pick this key" nudge.
    this.#refreshKeyStatus();
  }

  /**
   * Ask main whether the current key path needs re-picking to stay readable
   * (Feature 190, MAS only) and reflect it in the warning. Off MAS / with a
   * bookmark present this resolves `needsRepick:false` and shows nothing. A result
   * for a path the user has since changed (or a non-key type) is ignored.
   */
  async #refreshKeyStatus() {
    if (this.#form.authType !== "key" || !this.#form.keyPath) return;
    const path = this.#form.keyPath;
    let status;
    try {
      status = await this.#keyStatus(path);
    } catch {
      return; // query unavailable / failed → no nudge (fail safe)
    }
    if (this.#form.authType !== "key" || this.#form.keyPath !== path) return;
    const needs = status?.needsRepick === true;
    if (needs !== this.#form.keyNeedsRepick) {
      this.#form.keyNeedsRepick = needs;
      this.#renderTypeFields();
    }
  }

  /** The default auth type for a NEW credential: agent when this build allows it. */
  #defaultAuthType() {
    return can("sshAgentAuth") ? "agent" : "key";
  }

  /**
   * The auth types this build offers. A store build without ssh-agent support
   * (the MAS sandbox) drops "agent" — unless the credential being edited already
   * uses it, so it still displays (with a warning) and can be switched away from.
   */
  #availableTypes() {
    if (can("sshAgentAuth")) return AUTH_TYPES;
    const usable = AUTH_TYPES.filter((type) => type !== "agent");
    return this.#loadedType === "agent" ? ["agent", ...usable] : usable;
  }

  #populateTypeOptions() {
    clear(this.#typeSelect);
    this.#typeSelect.append(
      ...this.#availableTypes().map((type) =>
        el("option", { value: type, text: t(`auth.type.${type}`) }),
      ),
    );
  }

  buildPayload() {
    const authType = this.#form.authType;
    const payload = {
      label: this.#form.label.trim(),
      user: this.#form.user.trim(),
      authType,
    };
    if (authType === "key") payload.keyPath = this.#form.keyPath.trim();

    const secretField = secretFieldForAuthType(authType);
    if (secretField) {
      if (this.#form.secretValue.length > 0) {
        payload[secretField] = this.#form.secretValue; // a freshly typed secret
      } else if (this.#retainable()) {
        payload.hasSecret = true; // keep the stored ciphertext untouched
      }
    }
    return payload;
  }

  /** True when the secret field still points at its loaded type + had a secret. */
  #retainable() {
    return this.#form.authType === this.#loadedType && this.#hadSecret;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  #buildBody() {
    this.#labelInput = el("input", {
      class: "dialog-input cred-label-input",
      type: "text",
      placeholder: t("cred.label.placeholder"),
      "aria-label": t("cred.label"),
      "data-autofocus": true,
      onInput: (e) => (this.#form.label = e.target.value),
    });
    this.#userInput = el("input", {
      class: "dialog-input cred-user-input",
      type: "text",
      placeholder: t("cred.user.placeholder"),
      "aria-label": t("cred.user"),
      onInput: (e) => (this.#form.user = e.target.value),
    });
    this.#typeSelect = el("select", {
      class: "dialog-input cred-type-select",
      "aria-label": t("auth.type"),
      onChange: (e) => this.#changeType(e.target.value),
    });
    this.#populateTypeOptions();
    this.#typeFieldsEl = el("div", { class: "cred-type-fields" });

    this.#dialog.body.append(
      field({
        label: t("cred.label"),
        control: this.#labelInput,
        errorKey: "label",
      }),
      field({
        label: t("cred.user"),
        control: this.#userInput,
        errorKey: "user",
      }),
      field({
        label: t("auth.type"),
        control: this.#typeSelect,
        errorKey: "authType",
      }),
      this.#typeFieldsEl,
    );
    this.#renderTypeFields();
  }

  #renderTypeFields() {
    clear(this.#typeFieldsEl);
    const type = this.#form.authType;

    if (type === "agent") {
      // In a build without ssh-agent support (MAS sandbox) an existing agent
      // credential still opens here — warn that it can't authenticate and to
      // switch to a key or password, rather than showing the normal hint.
      const supported = can("sshAgentAuth");
      this.#typeFieldsEl.append(
        el("p", {
          class: supported
            ? "auth-agent-hint"
            : "auth-agent-hint auth-agent-warning",
          text: t(supported ? "auth.agentHint" : "auth.agentUnavailable"),
        }),
      );
      return;
    }

    if (type === "key") {
      const pathInput = el("input", {
        class: "dialog-input auth-input cred-keypath-input",
        type: "text",
        value: this.#form.keyPath,
        placeholder: t("auth.keyPath.placeholder"),
        "aria-label": t("auth.keyPath"),
        onInput: (e) => (this.#form.keyPath = e.target.value),
      });
      const browseBtn = el("button", {
        class: "btn btn--secondary auth-browse-btn",
        type: "button",
        text: t("auth.browse"),
        onClick: () => this.#browse(pathInput),
      });
      this.#typeFieldsEl.append(
        field({
          label: t("auth.keyPath"),
          control: el("div", { class: "auth-keypath-row" }, [
            pathInput,
            browseBtn,
          ]),
          errorKey: "keyPath",
          // Feature 190 (MAS): confirm a picked key was bookmarked for reuse.
          hint: this.#form.keyRemembered ? t("auth.keyRemembered") : undefined,
        }),
      );
      // Feature 190 (MAS): the stored key has no bookmark, so it can't be read
      // after a relaunch — prompt a re-pick (Browse re-mints the bookmark).
      if (this.#form.keyNeedsRepick && !this.#form.keyRemembered) {
        this.#typeFieldsEl.append(
          el("p", {
            class: "auth-keypath-warning",
            text: t("auth.keyNeedsRepick"),
          }),
        );
      }
    }

    const secretField = secretFieldForAuthType(type);
    if (secretField) this.#typeFieldsEl.append(this.#secretField(secretField));
  }

  #secretField(secretField) {
    const id = nextId();
    const retainable = this.#retainable();
    const status = el("span", {
      class: "auth-secret-status",
      text: t("auth.secretSet"),
      hidden: !(retainable && this.#form.secretValue.length === 0),
    });
    const input = el("input", {
      id,
      class: "dialog-input auth-input cred-secret-input",
      type: "password",
      value: this.#form.secretValue,
      autocomplete: "new-password",
      placeholder: retainable ? t("auth.secretKeep") : "",
      "aria-label": t(`auth.${secretField}`),
      onInput: (e) => {
        this.#form.secretValue = e.target.value;
        status.hidden = !(retainable && this.#form.secretValue.length === 0);
      },
    });
    // An existing password credential loaded WITHOUT a secret (e.g. imported from a
    // stripped bundle / SSH config, Feature 120) needs its password re-entered
    // before it can authenticate — surface that inline.
    const needsSecret =
      this.#editingId &&
      secretField === "password" &&
      this.#form.authType === this.#loadedType &&
      !this.#hadSecret;

    return field({
      label: t(`auth.${secretField}`),
      control: el("div", { class: "auth-secret-row" }, [input, status]),
      labelFor: id,
      hint: needsSecret ? t("cred.needsSecret.hint") : undefined,
    });
  }

  #changeType(type) {
    if (!AUTH_TYPES.includes(type) || this.#form.authType === type) return;
    this.#form.authType = type;
    this.#form.secretValue = ""; // a password isn't a passphrase — never carry over
    this.#renderTypeFields();
    // Switching TO key with a retained path may need the re-pick nudge (F190).
    if (type === "key") this.#refreshKeyStatus();
  }

  async #browse(pathInput) {
    // main returns `{ path, remembered }` (Feature 190); tolerate a bare string
    // too so an injected picker stays compatible. Pass the current path so the
    // panel opens at that key's location (pre-selected) when re-picking.
    const picked = await this.#openKeyFile(this.#form.keyPath || undefined);
    const path = typeof picked === "string" ? picked : picked?.path;
    if (!path) return;
    this.#form.keyPath = path;
    pathInput.value = path;
    // A fresh pick that minted a bookmark (MAS) clears any "re-pick" warning and
    // shows the "remembered" reassurance. Off MAS `remembered` is always false.
    const remembered =
      typeof picked === "object" && picked?.remembered === true;
    this.#form.keyRemembered = remembered;
    if (remembered) this.#form.keyNeedsRepick = false;
    this.#renderTypeFields();
    // Re-confirm the new path's status against main (authoritative — covers a MAS
    // pick whose bookmark failed to store, and clears a stale nudge off MAS).
    this.#refreshKeyStatus();
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async #save() {
    const payload = this.buildPayload();
    const { valid, errors } = validateCredential(payload);
    applyFieldErrors(this.#dialog.body, errors);
    if (!valid) return;

    let result;
    try {
      result = this.#editingId
        ? await this.#jumphippo.credentials.update(this.#editingId, payload)
        : await this.#jumphippo.credentials.create(payload);
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
      new CustomEvent("jumphippo:credentials-changed", {
        detail: { id: result && result.id },
      }),
    );
    this.#onSaved?.(result);
  }
}

// ── Blank-state helpers ───────────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v : "";
}
function blankForm() {
  return {
    label: "",
    user: "",
    authType: "agent",
    keyPath: "",
    secretValue: "",
    keyRemembered: false,
    keyNeedsRepick: false,
  };
}
