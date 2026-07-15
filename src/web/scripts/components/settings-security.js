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

// settings-security.js — the Settings → Security panel (selectable secret storage,
// Feature 90), split out of settings-popup.js so the popup keeps only the app
// settings. A three-option radiogroup over the at-rest backend. Everything renders
// inline (PopupManager only hosts one popup, so a nested confirm would detach
// Settings): a non-master switch shows an inline confirm bar; master-password
// reveals inline set/confirm fields; a locked session shows an inline unlock row.
// Intents go out over window.porthippo.secretStorage.*; a decrypted secret never
// comes back. Fully self-contained — the popup just mounts `element` and calls
// `load()` when the Security tab is revealed.

import { el } from "../dom.js";
import { t } from "../i18n.js";

export class SecuritySettings {
  #porthippo;
  #root;
  #securityState = null; // last { mode, locked, available, hasPassword }
  #pendingMode = null; // a non-master mode awaiting inline switch confirmation

  constructor({ porthippo } = {}) {
    this.#porthippo =
      porthippo ||
      (typeof window !== "undefined" ? window.porthippo : undefined);
    this.#root = this.#securityPanel();

    // A mode/lock change (ours or from elsewhere — menu, another window) refreshes
    // the panel in place. Payload carries only status, never a secret.
    if (typeof window !== "undefined") {
      window.addEventListener("porthippo:secret-storage-changed", (event) => {
        this.#applySecurityState(event.detail);
      });
    }
  }

  /** The `.settings-panel[data-panel="security"]` section the popup mounts. */
  get element() {
    return this.#root;
  }

  #securityPanel() {
    return el(
      "section",
      { class: "settings-panel", dataset: { panel: "security" }, hidden: true },
      [
        el("h3", {
          class: "settings-subhead",
          text: t("settings.security.heading"),
        }),
        el("p", { class: "settings-help", text: t("settings.security.help") }),

        // Locked master-password session: enter the password to unlock (hidden
        // unless the active mode is master-password and no key is loaded).
        el("div", { class: "security-locked-row", hidden: true }, [
          el("p", {
            class: "settings-help",
            text: t("settings.security.lockedNote"),
          }),
          this.#secretField(
            "security-unlock-pw",
            t("settings.security.password"),
            () => this.#unlockMaster(),
            el("button", {
              class: "btn btn--secondary security-unlock-btn",
              type: "button",
              text: t("settings.security.unlock"),
              onClick: () => this.#unlockMaster(),
            }),
          ),
        ]),

        el(
          "div",
          {
            class: "security-mode-group",
            role: "radiogroup",
            "aria-label": t("settings.security.modeAria"),
          },
          [
            this.#securityModeOption(
              "app-key",
              "settings.security.mode.appKey",
              "settings.security.mode.appKeyDesc",
            ),
            this.#securityModeOption(
              "os-keychain",
              "settings.security.mode.osKeychain",
              "settings.security.mode.osKeychainDesc",
            ),
            this.#securityModeOption(
              "master-password",
              "settings.security.mode.masterPassword",
              "settings.security.mode.masterPasswordDesc",
              this.#masterFields(),
            ),
          ],
        ),

        // Inline switch-confirm for the two no-password modes.
        el("div", { class: "security-confirm-row", hidden: true }, [
          el("p", {
            class: "settings-help",
            text: t("settings.security.switchMessage"),
          }),
          el("div", { class: "security-confirm-actions" }, [
            el("button", {
              class: "btn btn--secondary security-confirm-cancel",
              type: "button",
              text: t("common.cancel"),
              onClick: () => this.#cancelSwitch(),
            }),
            el("button", {
              class: "btn btn--primary security-confirm-apply",
              type: "button",
              text: t("settings.security.switchConfirm"),
              onClick: () => this.#applyMode(this.#pendingMode),
            }),
          ]),
        ]),

        el("p", {
          class: "security-status",
          role: "status",
          "aria-live": "polite",
        }),
      ],
    );
  }

  // One radio card; `extra` (the master-password fields) nests inside when given.
  #securityModeOption(value, labelKey, descKey, extra) {
    const head = el("label", { class: "security-mode-head" }, [
      el("input", {
        type: "radio",
        name: "secret-storage-mode",
        value,
        class: "security-mode-radio",
        onChange: () => this.#onSecurityModeChange(value),
      }),
      el("span", { class: "security-mode-text" }, [
        el("span", { class: "security-mode-label", text: t(labelKey) }),
        el("span", { class: "security-mode-desc", text: t(descKey) }),
      ]),
    ]);
    return el(
      "div",
      {
        class: extra
          ? "security-mode-option security-mode-option--expandable"
          : "security-mode-option",
      },
      [head, extra].filter(Boolean),
    );
  }

  // The inline set-a-master-password fields (hidden until master-password is
  // selected). The Apply button commits the switch (which re-encrypts secrets).
  #masterFields() {
    return el("div", { class: "security-master-fields", hidden: true }, [
      this.#secretField("security-master-pw", t("settings.security.password")),
      this.#secretField(
        "security-master-pw-confirm",
        t("settings.security.confirmPassword"),
        () => this.#applyMasterPassword(),
      ),
      el("p", {
        class: "settings-help security-master-warn",
        text: t("settings.security.setPasswordWarn"),
      }),
      el("button", {
        class: "btn btn--primary security-master-apply",
        type: "button",
        text: t("settings.security.setPasswordSubmit"),
        onClick: () => this.#applyMasterPassword(),
      }),
    ]);
  }

  // A masked password input with a show/hide reveal toggle, plus optional trailing
  // control (e.g. an Unlock button). `onEnter` fires on the Enter key.
  #secretField(className, ariaLabel, onEnter, trailing) {
    const input = el("input", {
      type: "password",
      class: `settings-input security-secret-input ${className}`,
      autocomplete: "new-password",
      spellcheck: false,
      "aria-label": ariaLabel,
      placeholder: ariaLabel,
      onKeydown: (e) => {
        if (e.key === "Enter" && onEnter) {
          e.preventDefault();
          onEnter();
        }
      },
    });
    const reveal = el("button", {
      class: "btn btn--icon security-reveal-btn",
      type: "button",
      text: "👁",
      title: t("settings.security.reveal"),
      "aria-label": t("settings.security.reveal"),
      onClick: () => {
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        const key = show
          ? "settings.security.hide"
          : "settings.security.reveal";
        reveal.title = t(key);
        reveal.setAttribute("aria-label", t(key));
      },
    });
    return el(
      "div",
      { class: "security-inline-field" },
      [input, reveal, trailing].filter(Boolean),
    );
  }

  // ── State + actions ───────────────────────────────────────────────────────────

  /** (Re)read the live secret-storage state from main and reflect it in the panel. */
  async load() {
    let state;
    try {
      state = await this.#porthippo?.secretStorage?.getMode?.();
    } catch {
      return; // leave the panel as-is on a read failure
    }
    if (state) this.#applySecurityState(state);
  }

  // Reflect a { mode, locked, available, hasPassword } snapshot into the panel.
  #applySecurityState(state) {
    if (!state || typeof state !== "object") return;
    this.#securityState = state;
    if (!this.#root) return;

    this.#syncSecurityRadio(state.mode);
    this.#showMasterFields(false);
    this.#showConfirmBar(false);
    this.#pendingMode = null;

    const keychainRadio = this.#root.querySelector(
      '.security-mode-radio[value="os-keychain"]',
    );
    if (keychainRadio) keychainRadio.disabled = !state.available;

    const lockedRow = this.#root.querySelector(".security-locked-row");
    if (lockedRow) lockedRow.hidden = !state.locked;

    this.#setSecurityStatus("");
  }

  // A radio was picked. app-key/os-keychain → inline confirm; master-password →
  // reveal the set-password fields (the switch commits on Apply).
  #onSecurityModeChange(target) {
    const current = this.#securityState?.mode;
    this.#setSecurityStatus("");
    if (target === current) {
      this.#showMasterFields(false);
      this.#showConfirmBar(false);
      return;
    }
    if (target === "master-password") {
      this.#showConfirmBar(false);
      this.#showMasterFields(true);
      return;
    }
    this.#showMasterFields(false);
    this.#pendingMode = target;
    this.#showConfirmBar(true);
  }

  // The user backed out of a pending no-password switch: revert the radio.
  #cancelSwitch() {
    this.#pendingMode = null;
    this.#showConfirmBar(false);
    this.#syncSecurityRadio(this.#securityState?.mode);
  }

  async #applyMode(target) {
    if (!target) return;
    this.#showConfirmBar(false);
    this.#setSecurityStatus(t("settings.security.switching"));
    let res;
    try {
      res = await this.#porthippo?.secretStorage?.setMode?.({ mode: target });
    } catch {
      res = { ok: false, reason: "error" };
    }
    this.#afterMutation(res);
  }

  async #applyMasterPassword() {
    const pw = this.#secretValue("security-master-pw");
    const confirm = this.#secretValue("security-master-pw-confirm");
    if (!pw) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordRequired"),
        true,
      );
      return;
    }
    if (pw !== confirm) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordMismatch"),
        true,
      );
      return;
    }
    this.#setSecurityStatus(t("settings.security.switching"));
    let res;
    try {
      res = await this.#porthippo?.secretStorage?.setMode?.({
        mode: "master-password",
        password: pw,
      });
    } catch {
      res = { ok: false, reason: "error" };
    }
    this.#afterMutation(res);
  }

  async #unlockMaster() {
    const input = this.#root.querySelector(".security-unlock-pw");
    const pw = input ? input.value : "";
    if (!pw) {
      this.#setSecurityStatus(
        t("settings.security.error.passwordRequired"),
        true,
      );
      return;
    }
    this.#setSecurityStatus(t("settings.security.unlocking"));
    let res;
    try {
      res = await this.#porthippo?.secretStorage?.unlock?.(pw);
    } catch {
      res = { ok: false, reason: "error" };
    }
    if (res && res.ok) {
      this.#clearSecretInputs();
      this.load(); // refresh now (the broadcast also arrives)
      return;
    }
    this.#setSecurityStatus(
      res?.reason === "bad-password"
        ? t("settings.security.error.badPassword")
        : t("settings.security.error.generic"),
      true,
    );
    if (input) {
      input.value = "";
      input.focus();
    }
  }

  // Shared success/failure tail for a mode switch. On success the panel refreshes
  // (here and via the porthippo:secret-storage-changed broadcast); on failure the
  // radio snaps back to the still-current mode and the reason shows.
  #afterMutation(res) {
    if (res && res.ok) {
      this.#clearSecretInputs();
      this.load();
      return;
    }
    this.#setSecurityStatus(this.#switchErrorMessage(res?.reason), true);
    this.#syncSecurityRadio(this.#securityState?.mode);
    this.#showMasterFields(false);
    this.#showConfirmBar(false);
  }

  #switchErrorMessage(reason) {
    switch (reason) {
      case "keychain-unavailable":
        return t("settings.security.error.keychainUnavailable");
      case "locked":
        return t("settings.security.error.lockedSwitch");
      case "migration-failed":
        return t("settings.security.error.migrationFailed");
      case "password-required":
        return t("settings.security.error.passwordRequired");
      default:
        return t("settings.security.error.generic");
    }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  #syncSecurityRadio(mode) {
    for (const radio of this.#root.querySelectorAll(".security-mode-radio")) {
      radio.checked = radio.value === mode;
    }
  }

  #showMasterFields(show) {
    const fields = this.#root.querySelector(".security-master-fields");
    if (fields) fields.hidden = !show;
    if (show) this.#root.querySelector(".security-master-pw")?.focus();
    else this.#clearSecret("security-master-pw", "security-master-pw-confirm");
  }

  #showConfirmBar(show) {
    const row = this.#root.querySelector(".security-confirm-row");
    if (row) row.hidden = !show;
  }

  #setSecurityStatus(message, isError = false) {
    const status = this.#root.querySelector(".security-status");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle(
      "security-status--error",
      Boolean(message) && isError,
    );
  }

  #secretValue(className) {
    const input = this.#root.querySelector(`.${className}`);
    return input ? input.value : "";
  }

  #clearSecret(...classNames) {
    for (const c of classNames) {
      const input = this.#root.querySelector(`.${c}`);
      if (input) {
        input.value = "";
        input.type = "password";
      }
    }
  }

  #clearSecretInputs() {
    this.#clearSecret(
      "security-master-pw",
      "security-master-pw-confirm",
      "security-unlock-pw",
    );
  }
}
