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
import { SecuritySettings } from "./settings-security.js";
import { HostKeysPanel } from "./host-keys-panel.js";
import { ImportExportDialog } from "./import-export-dialog.js";

const PANELS = [
  "appearance",
  "defaults",
  "behaviour",
  "reliability",
  "security",
  "hostkeys",
  "data",
];

export class SettingsPopup {
  #porthippo;
  #el = null;
  #built = false;
  #loadedLanguage = null;
  #security; // the Settings → Security panel (selectable secret storage)
  #hostKeys; // the Settings → Host Keys panel (accepted TOFU fingerprints)
  #impexp = null; // the Settings → Data import/export dialog (lazy)

  constructor({ porthippo } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    // Owns the Security tab (its DOM, state, and the secret-storage-changed
    // subscription); the popup just mounts it and asks it to reload on reveal.
    this.#security = new SecuritySettings({ porthippo: this.#porthippo });
    // Likewise owns the Host Keys tab: mounted here, reloaded on reveal.
    this.#hostKeys = new HostKeysPanel({ porthippo: this.#porthippo });
  }

  /** The import/export dialog, built on first use (it stacks over this popup). */
  #importExport() {
    if (!this.#impexp) {
      this.#impexp = new ImportExportDialog({ porthippo: this.#porthippo });
    }
    return this.#impexp;
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
      this.#reliabilityPanel(),
      this.#security.element,
      this.#hostKeys.element,
      this.#dataPanel(),
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
      // Feature 150 — the scheduling master switch. Off by default; per-tunnel /
      // per-group schedules only take effect while this is on.
      this.#check(
        "setting-schedulingEnabled",
        "settings.behaviour.scheduling",
        "settings.behaviour.scheduling.hint",
      ),
    ]);
  }

  // Notifications & reliability (Feature 130): desktop notification prefs (master
  // + per-event toggles, flap cooldown), the SSH keepalive probe interval, and the
  // reconnect backoff policy. All read live by the engine / notifier in main; the
  // per-tunnel reconnect override lives in the tunnel editor's Advanced section.
  #reliabilityPanel() {
    return this.#panel("reliability", [
      el("p", { class: "settings-help", text: t("settings.reliability.help") }),
      this.#check(
        "setting-notificationsEnabled",
        "settings.reliability.notificationsEnabled",
        "settings.reliability.notificationsEnabled.hint",
      ),
      this.#check("setting-notifyOnDrop", "settings.reliability.notifyOnDrop"),
      this.#check(
        "setting-notifyOnRecover",
        "settings.reliability.notifyOnRecover",
      ),
      this.#check(
        "setting-notifyOnGiveUp",
        "settings.reliability.notifyOnGiveUp",
      ),
      field({
        label: t("settings.reliability.cooldown"),
        labelFor: "setting-notifyCooldownMs",
        control: this.#num("setting-notifyCooldownMs", "0", "1000"),
        hint: t("settings.reliability.cooldown.hint"),
      }),
      field({
        label: t("settings.reliability.keepalive"),
        labelFor: "setting-sshKeepaliveSeconds",
        control: this.#num("setting-sshKeepaliveSeconds", "0", "1"),
        hint: t("settings.reliability.keepalive.hint"),
      }),
      field({
        label: t("settings.reliability.reconnectBase"),
        labelFor: "setting-reconnectBaseMs",
        control: this.#num("setting-reconnectBaseMs", "1", "100"),
        hint: t("settings.reliability.reconnectBase.hint"),
      }),
      field({
        label: t("settings.reliability.reconnectMax"),
        labelFor: "setting-reconnectMaxMs",
        control: this.#num("setting-reconnectMaxMs", "1", "1000"),
      }),
      field({
        label: t("settings.reliability.reconnectAttempts"),
        labelFor: "setting-reconnectMaxAttempts",
        control: this.#num("setting-reconnectMaxAttempts", "0", "1"),
        hint: t("settings.reliability.reconnectAttempts.hint"),
      }),
    ]);
  }

  // A number <input> that emits on change (shared by the reliability fields).
  #num(id, min, step) {
    return el("input", {
      id,
      class: "settings-input",
      type: "number",
      min,
      step,
      onChange: () => this.#emitChange(),
    });
  }

  // Import / export (Feature 120). Each action opens the ImportExportDialog, which
  // stacks over this popup as a native modal; the file pickers themselves open in
  // main. All the work happens there — this panel is just the three entry points.
  #dataPanel() {
    const action = (labelKey, descKey, onClick) =>
      el("div", { class: "settings-data-action" }, [
        el("button", {
          class: "btn btn--secondary settings-data-btn",
          type: "button",
          text: t(labelKey),
          onClick,
        }),
        el("p", { class: "field-hint", text: t(descKey) }),
      ]);

    return this.#panel("data", [
      el("p", { class: "settings-help", text: t("io.data.help") }),
      action("io.data.export", "io.data.exportDesc", () =>
        this.#importExport().openExport(),
      ),
      action("io.data.importBundle", "io.data.importBundleDesc", () =>
        this.#importExport().startImport(),
      ),
      action("io.data.importSsh", "io.data.importSshDesc", () =>
        this.#importExport().startSshImport(),
      ),
    ]);
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
    // The Security and Host Keys tabs read live main-process state, so refresh
    // whichever is being revealed.
    if (name === "security") this.#security.load();
    if (name === "hostkeys") this.#hostKeys.load();
  }

  #get(id) {
    return this.#el.querySelector(`#${id}`);
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
    if (s.schedulingEnabled !== undefined)
      this.#get("setting-schedulingEnabled").checked = Boolean(
        s.schedulingEnabled,
      );
    // Feature 130 — notifications & reliability.
    if (s.notificationsEnabled !== undefined)
      this.#get("setting-notificationsEnabled").checked = Boolean(
        s.notificationsEnabled,
      );
    if (s.notifyOnDrop !== undefined)
      this.#get("setting-notifyOnDrop").checked = Boolean(s.notifyOnDrop);
    if (s.notifyOnRecover !== undefined)
      this.#get("setting-notifyOnRecover").checked = Boolean(s.notifyOnRecover);
    if (s.notifyOnGiveUp !== undefined)
      this.#get("setting-notifyOnGiveUp").checked = Boolean(s.notifyOnGiveUp);
    if (s.notifyCooldownMs !== undefined)
      this.#get("setting-notifyCooldownMs").value = String(s.notifyCooldownMs);
    if (s.sshKeepaliveSeconds !== undefined)
      this.#get("setting-sshKeepaliveSeconds").value = String(
        s.sshKeepaliveSeconds,
      );
    if (s.reconnectBaseMs !== undefined)
      this.#get("setting-reconnectBaseMs").value = String(s.reconnectBaseMs);
    if (s.reconnectMaxMs !== undefined)
      this.#get("setting-reconnectMaxMs").value = String(s.reconnectMaxMs);
    if (s.reconnectMaxAttempts !== undefined)
      this.#get("setting-reconnectMaxAttempts").value = String(
        s.reconnectMaxAttempts,
      );
  }

  /** Read an integer control, clamped to `min`, falling back to `dflt`. */
  #intVal(id, dflt, min) {
    const n = parseInt(this.#get(id).value, 10);
    return Number.isFinite(n) && n >= min ? n : dflt;
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
      schedulingEnabled: this.#get("setting-schedulingEnabled").checked,
      // Feature 130 — notifications & reliability (defaults mirror settings-store).
      notificationsEnabled: this.#get("setting-notificationsEnabled").checked,
      notifyOnDrop: this.#get("setting-notifyOnDrop").checked,
      notifyOnRecover: this.#get("setting-notifyOnRecover").checked,
      notifyOnGiveUp: this.#get("setting-notifyOnGiveUp").checked,
      notifyCooldownMs: this.#intVal("setting-notifyCooldownMs", 60000, 0),
      sshKeepaliveSeconds: this.#intVal("setting-sshKeepaliveSeconds", 15, 0),
      reconnectBaseMs: this.#intVal("setting-reconnectBaseMs", 1000, 1),
      reconnectMaxMs: this.#intVal("setting-reconnectMaxMs", 30000, 1),
      reconnectMaxAttempts: this.#intVal("setting-reconnectMaxAttempts", 6, 0),
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
