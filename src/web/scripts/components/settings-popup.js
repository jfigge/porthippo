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

// settings-popup.js — the Settings panel (Feature 60), following Rest Hippo's
// SettingsPopup pattern: a tabbed popup over the shared PopupManager with NO
// Save button — every change applies live. On change it persists the whole
// settings object via `window.porthippo.settings.set(...)` and dispatches a
// global `porthippo:settings-changed` CustomEvent so consumers (app.js theme,
// the engine's live-read defaults) react. A language change reloads the window
// so every string re-resolves against the new catalog.
//
// The DOM is built lazily on first open() — the popup is constructed at module
// load, before i18n.init() has resolved, so building eagerly would bake in
// untranslated keys.

import { el } from "../dom.js";
import { field } from "../field.js";
import { PopupManager } from "../popup-manager.js";
import { t, LOCALE_OPTIONS } from "../i18n.js";

const PANELS = ["appearance", "defaults", "behaviour", "security"];

export class SettingsPopup {
  #porthippo;
  #el = null;
  #built = false;
  #loadedLanguage = null;
  #securityState = null; // last { mode, locked, available, hasPassword }
  #pendingMode = null; // a non-master mode awaiting inline switch confirmation

  constructor({ porthippo } = {}) {
    this.#porthippo = porthippo || window.porthippo;

    // A mode/lock change (ours or from elsewhere — menu, another window) refreshes
    // the Security tab in place. Payload carries only status, never a secret.
    window.addEventListener("porthippo:secret-storage-changed", (event) => {
      this.#applySecurityState(event.detail);
    });
  }

  /** Load current settings and open the popup. */
  async open() {
    let settings = {};
    try {
      settings = (await this.#porthippo?.settings?.get?.()) || {};
    } catch {
      // Fall back to empty → controls show their built-in defaults.
    }
    this.#ensureBuilt();
    this.#applyValues(settings);
    this.#loadedLanguage = settings.language ?? "system";
    this.#showPanel("appearance");
    PopupManager.open({ element: this.#el });
  }

  /**
   * Reflect an externally-changed appearance value (e.g. a Cmd +/- zoom step)
   * into the controls WITHOUT re-emitting a change. No-ops before the popup is
   * built or when a field is absent, so it's safe to call from app-wide handlers.
   */
  syncAppearance(partial) {
    if (!this.#built || !partial) return;
    if (partial.fontSize !== undefined) {
      const el = this.#get("setting-font-size");
      if (el) el.value = String(partial.fontSize);
    }
    if (partial.fontFamily !== undefined) {
      const el = this.#get("setting-font-family");
      if (el) el.value = partial.fontFamily;
    }
  }

  // ── Build ────────────────────────────────────────────────────────────────

  #ensureBuilt() {
    if (this.#built) return;
    this.#el = this.#build();
    this.#built = true;
  }

  #build() {
    const nav = el(
      "nav",
      { class: "settings-nav", role: "tablist" },
      PANELS.map((name) =>
        el("button", {
          class: "settings-nav-item",
          type: "button",
          role: "tab",
          dataset: { panel: name },
          text: t(`settings.nav.${name}`),
          onClick: () => this.#showPanel(name),
        }),
      ),
    );

    const panels = el("div", { class: "settings-panels" }, [
      this.#appearancePanel(),
      this.#defaultsPanel(),
      this.#behaviourPanel(),
      this.#securityPanel(),
    ]);

    const closeBtn = el("button", {
      class: "btn popup-btn btn--primary",
      type: "button",
      text: t("common.close"),
      onClick: () => PopupManager.close(),
      "data-autofocus": true,
    });

    const diagnosticsBtn = el("button", {
      class: "btn popup-btn btn--ghost",
      type: "button",
      text: t("tray.copyDiagnostics"),
      onClick: () => this.#porthippo?.diagnostics?.copy?.(),
    });

    return el(
      "div",
      {
        class: "popup popup-settings",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": t("settings.title"),
      },
      [
        el("div", { class: "popup-header" }, [
          el("span", { class: "popup-title", text: t("settings.title") }),
        ]),
        el("div", { class: "settings-body" }, [nav, panels]),
        el("div", { class: "popup-footer settings-footer" }, [
          diagnosticsBtn,
          closeBtn,
        ]),
      ],
    );
  }

  #panel(name, children) {
    return el(
      "section",
      { class: "settings-panel", dataset: { panel: name }, hidden: true },
      children,
    );
  }

  #appearancePanel() {
    const themeSelect = this.#select("setting-theme", "theme", [
      { value: "system", text: t("settings.appearance.theme.system") },
      { value: "light", text: t("settings.appearance.theme.light") },
      { value: "dark", text: t("settings.appearance.theme.dark") },
    ]);
    const languageSelect = this.#select(
      "setting-language",
      "language",
      LOCALE_OPTIONS.map((o) => ({
        value: o.value,
        text: o.labelKey ? t(o.labelKey) : o.label,
      })),
    );
    const fontSizeSelect = this.#select(
      "setting-font-size",
      "fontSize",
      [11, 12, 13, 14, 16, 18].map((n) => ({
        value: String(n),
        text: `${n} px`,
      })),
    );
    const fontFamilySelect = this.#select("setting-font-family", "fontFamily", [
      { value: "inter", text: "Inter" },
      { value: "system", text: t("settings.appearance.fontFamily.system") },
      { value: "sf-pro", text: "SF Pro (macOS)" },
      { value: "segoe", text: "Segoe UI (Windows)" },
      { value: "ubuntu", text: "Ubuntu (Linux)" },
      { value: "roboto", text: "Roboto" },
    ]);

    return this.#panel("appearance", [
      field({
        label: t("settings.appearance.theme"),
        labelFor: "setting-theme",
        control: themeSelect,
      }),
      field({
        label: t("settings.appearance.language"),
        labelFor: "setting-language",
        control: languageSelect,
      }),
      field({
        label: t("settings.appearance.fontSize"),
        labelFor: "setting-font-size",
        control: fontSizeSelect,
        hint: t("settings.appearance.fontSize.hint"),
      }),
      field({
        label: t("settings.appearance.fontFamily"),
        labelFor: "setting-font-family",
        control: fontFamilySelect,
      }),
    ]);
  }

  #defaultsPanel() {
    const linger = el("input", {
      id: "setting-lingerMs",
      class: "settings-input",
      type: "number",
      min: "0",
      step: "1000",
      onChange: () => this.#emitChange(),
    });
    const bindHost = el("input", {
      id: "setting-bindHost",
      class: "settings-input",
      type: "text",
      onInput: () => this.#emitChange(),
    });

    return this.#panel("defaults", [
      field({
        label: t("settings.defaults.linger"),
        labelFor: "setting-lingerMs",
        control: linger,
        hint: t("settings.defaults.linger.hint"),
      }),
      field({
        label: t("settings.defaults.bindHost"),
        labelFor: "setting-bindHost",
        control: bindHost,
        hint: t("settings.defaults.bindHost.hint"),
      }),
      this.#check(
        "setting-keepAlive",
        "settings.defaults.keepAlive",
        "settings.defaults.keepAlive.hint",
      ),
    ]);
  }

  #behaviourPanel() {
    return this.#panel("behaviour", [
      this.#check("setting-launchAtLogin", "settings.behaviour.launchAtLogin"),
      this.#check(
        "setting-startMinimized",
        "settings.behaviour.startMinimized",
        "settings.behaviour.startMinimized.hint",
      ),
      this.#check("setting-armOnLaunch", "settings.behaviour.armOnLaunch"),
      this.#check(
        "setting-confirmOnQuit",
        "settings.behaviour.confirmOnQuit",
        "settings.behaviour.confirmOnQuit.hint",
      ),
    ]);
  }

  // ── Security (selectable secret storage, Feature 90) ─────────────────────────
  // A three-option radiogroup over the at-rest backend. Everything renders inline
  // (PopupManager only hosts one popup, so a nested confirm would detach Settings):
  // a non-master switch shows an inline confirm bar; master-password reveals inline
  // set/confirm fields; a locked session shows an inline unlock row. Intents go out
  // over window.porthippo.secretStorage.*; a decrypted secret never comes back.

  #securityPanel() {
    return this.#panel("security", [
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
    ]);
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

  // A labelled <select> that emits on change.
  #select(id, _key, options) {
    return el(
      "select",
      {
        id,
        class: "settings-input",
        onChange: () => this.#emitChange(),
      },
      options.map((o) => el("option", { value: o.value, text: o.text })),
    );
  }

  // A checkbox row: [✓] label, with an optional hint beneath.
  #check(id, labelKey, hintKey) {
    const input = el("input", {
      id,
      type: "checkbox",
      class: "settings-check-input",
      onChange: () => this.#emitChange(),
    });
    return el("div", { class: "field settings-check" }, [
      el("label", { class: "settings-check-label", for: id }, [
        input,
        el("span", { text: t(labelKey) }),
      ]),
      hintKey && el("p", { class: "field-hint", text: t(hintKey) }),
    ]);
  }

  // ── Panels / values ────────────────────────────────────────────────────────

  #showPanel(name) {
    for (const item of this.#el.querySelectorAll(".settings-nav-item")) {
      const on = item.dataset.panel === name;
      item.classList.toggle("settings-nav-item--active", on);
      item.setAttribute("aria-selected", String(on));
    }
    for (const panel of this.#el.querySelectorAll(".settings-panel")) {
      panel.hidden = panel.dataset.panel !== name;
    }
    // The Security tab reads live main-process state, so refresh it each reveal.
    if (name === "security") this.#loadSecurityState();
  }

  #get(id) {
    return this.#el.querySelector(`#${id}`);
  }

  // ── Security state + actions ─────────────────────────────────────────────────

  async #loadSecurityState() {
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
    if (!this.#built || !this.#el) return;

    this.#syncSecurityRadio(state.mode);
    this.#showMasterFields(false);
    this.#showConfirmBar(false);
    this.#pendingMode = null;

    const keychainRadio = this.#el.querySelector(
      '.security-mode-radio[value="os-keychain"]',
    );
    if (keychainRadio) keychainRadio.disabled = !state.available;

    const lockedRow = this.#el.querySelector(".security-locked-row");
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
    const input = this.#el.querySelector(".security-unlock-pw");
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
      this.#loadSecurityState(); // refresh now (the broadcast also arrives)
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
      this.#loadSecurityState();
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

  // ── Security DOM helpers ─────────────────────────────────────────────────────

  #syncSecurityRadio(mode) {
    for (const radio of this.#el.querySelectorAll(".security-mode-radio")) {
      radio.checked = radio.value === mode;
    }
  }

  #showMasterFields(show) {
    const fields = this.#el.querySelector(".security-master-fields");
    if (fields) fields.hidden = !show;
    if (show) this.#el.querySelector(".security-master-pw")?.focus();
    else this.#clearSecret("security-master-pw", "security-master-pw-confirm");
  }

  #showConfirmBar(show) {
    const row = this.#el.querySelector(".security-confirm-row");
    if (row) row.hidden = !show;
  }

  #setSecurityStatus(message, isError = false) {
    const status = this.#el.querySelector(".security-status");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle(
      "security-status--error",
      Boolean(message) && isError,
    );
  }

  #secretValue(className) {
    const input = this.#el.querySelector(`.${className}`);
    return input ? input.value : "";
  }

  #clearSecret(...classNames) {
    for (const c of classNames) {
      const input = this.#el.querySelector(`.${c}`);
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

  // Populate controls from a settings object; each guarded so a partial object
  // never clobbers an untouched control.
  #applyValues(s) {
    if (s.theme !== undefined) this.#get("setting-theme").value = s.theme;
    if (s.language !== undefined)
      this.#get("setting-language").value = s.language;
    if (s.fontSize !== undefined)
      this.#get("setting-font-size").value = String(s.fontSize);
    if (s.fontFamily !== undefined)
      this.#get("setting-font-family").value = s.fontFamily;
    if (s.defaultLingerMs !== undefined)
      this.#get("setting-lingerMs").value = String(s.defaultLingerMs);
    if (s.defaultBindHost !== undefined)
      this.#get("setting-bindHost").value = s.defaultBindHost;
    if (s.defaultKeepAlive !== undefined)
      this.#get("setting-keepAlive").checked = Boolean(s.defaultKeepAlive);
    if (s.launchAtLogin !== undefined)
      this.#get("setting-launchAtLogin").checked = Boolean(s.launchAtLogin);
    if (s.startMinimized !== undefined)
      this.#get("setting-startMinimized").checked = Boolean(s.startMinimized);
    if (s.armOnLaunch !== undefined)
      this.#get("setting-armOnLaunch").checked = Boolean(s.armOnLaunch);
    if (s.confirmOnQuit !== undefined)
      this.#get("setting-confirmOnQuit").checked = Boolean(s.confirmOnQuit);
  }

  #readValues() {
    const lingerRaw = Number(this.#get("setting-lingerMs").value);
    return {
      theme: this.#get("setting-theme").value,
      language: this.#get("setting-language").value,
      fontSize: parseInt(this.#get("setting-font-size").value, 10) || 13,
      fontFamily: this.#get("setting-font-family").value,
      defaultLingerMs:
        Number.isFinite(lingerRaw) && lingerRaw >= 0 ? lingerRaw : 0,
      defaultBindHost: this.#get("setting-bindHost").value.trim(),
      defaultKeepAlive: this.#get("setting-keepAlive").checked,
      launchAtLogin: this.#get("setting-launchAtLogin").checked,
      startMinimized: this.#get("setting-startMinimized").checked,
      armOnLaunch: this.#get("setting-armOnLaunch").checked,
      confirmOnQuit: this.#get("setting-confirmOnQuit").checked,
    };
  }

  // Persist + broadcast on every change. A language change additionally reloads
  // the window so all strings re-resolve against the new catalog.
  #emitChange() {
    const values = this.#readValues();
    const languageChanged = values.language !== this.#loadedLanguage;

    const saved = this.#porthippo?.settings?.set?.(values);
    Promise.resolve(saved)
      .catch(() => {})
      .finally(() => {
        if (languageChanged) {
          this.#loadedLanguage = values.language;
          window.location.reload();
        }
      });

    window.dispatchEvent(
      new CustomEvent("porthippo:settings-changed", { detail: values }),
    );
  }
}
