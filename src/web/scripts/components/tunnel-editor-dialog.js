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

// tunnel-editor-dialog.js — create/edit a tunnel in a native <dialog>, split across
// four tabs: General (Name, the three free-text address:port fields — Entry port /
// Target server / Exit port — the Credential, and the route-validation block),
// Jump Hosts (the jump-host chain), Config (idle linger, option toggles, reconnect
// override), and Schedule (the optional auto-arm rule). A validation error reveals
// the tab that owns the failing field.
//
// Each address field accepts a bare port, a bare host, or `address:port` and is
// parsed by address.js into the concrete data-model fields the store keeps:
//   Entry  → bindHost + localPort            (host defaults to 127.0.0.1)
//   Target → sshHost  + sshPort (mandatory)  (port defaults to 22)
//   Exit   → destination.host + .port        (defaults to 127.0.0.1 + the Entry port)
// The raw strings are ALSO stored verbatim (entryAddress / exitAddress) so the
// editor re-displays exactly what the user typed. See features/tunnel-address-fields.md.
//
// Validation is live-but-quiet until the first save attempt: parse errors + the
// structural validator drive inline field errors (remapped from the concrete
// data-model keys onto the owning address field). Three soft warnings never
// block the save — they surface conditions the engine would otherwise only reveal
// at arm time: a privileged Entry port (needs root/Administrator), an Entry port
// already claimed by another tunnel, and an Entry/Target host that doesn't resolve
// to a bindable local / reachable address. The store re-validates authoritatively.

import { el, clear } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { Dialog } from "../dialog.js";
import { validateDefinition, normaliseTunnelType } from "../validate.js";
import {
  parseEntry,
  parseTarget,
  parseExit,
  PRIVILEGED_PORT,
  LOOPBACK,
} from "../address.js";
import { CredentialPickerField } from "./credential-picker-field.js";
import { JumpHostPickerField } from "./jump-host-picker-field.js";
import { ScheduleEditorField } from "./schedule-editor-field.js";
import {
  LOOPBACKS,
  TYPE_ORDER,
  addressFieldConfig,
  looksLikeIp,
  toInt,
  addressErrorMessage,
  str,
  reconstructEntryField,
  reconstructExitField,
  reconstructTarget,
  blankForm,
  buildRetryOverride,
} from "./tunnel-editor-fields.js";

const RESOLVE_DEBOUNCE_MS = 300;

/** Spinner attributes for millisecond fields: step +/- 1000 ms, never negative. */
const MS_STEP = { step: "1000", min: "0" };

/** Render a stored number as an editor field string ("" for absent). */
const numStr = (v) => (v === undefined || v === null ? "" : String(v));

export class TunnelEditorDialog {
  #dialog;
  #jumphippo;
  #onSubmit;
  #onSaved;

  #form = blankForm();
  #controls = {};
  #credPicker;
  #jumpPicker;
  #scheduleField; // Feature 150 — the optional per-tunnel schedule section
  #typeSelect; // Feature 110 forwarding-type <select>
  #entryField; // the Entry/Remote-bind/SOCKS field wrapper (relabelled per type)
  #exitField; // the Exit/Local-target field wrapper (relabelled per type)
  #exitSection; // hidden for the dynamic (SOCKS) type
  #entryWarningEl; // privileged-port / port-conflict (instant, soft)
  #entryResolveWarnEl; // Entry host not a bindable local address (debounced)
  #targetResolveWarnEl; // Target server doesn't resolve locally (debounced)
  #editingId = null;
  #showErrors = false;
  #existing = []; // other tunnels, for the local-port conflict warning

  // Feature 100 — the "Test resolution" probe (walks the real chain). The button
  // lives in the dialog footer; results show in their own stacked <dialog> popup.
  #resolveBtn;
  #resolvePopup; // the native <dialog> that shows the probe results
  #resolveActionBtn; // the popup's Cancel-test / Close button
  #resolveResultsEl;
  #resolveTimer = null;
  #resolveSeq = 0; // guards against a stale debounced check applying late
  #probeRunning = false;
  #probeCancelled = false;

  /**
   * @param {object} opts
   * @param {object} [opts.jumphippo]  IPC bridge (defaults to window.jumphippo)
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   * @param {(payload: object, ctx: { id: string|null }) => Promise<object>} opts.onSubmit
   *        performs the store write and resolves to the record or a `{ __hippoError }`.
   * @param {(record: object) => void} [opts.onSaved]  fires after a successful write.
   */
  constructor({ jumphippo, openKeyFile, onSubmit, onSaved } = {}) {
    this.#jumphippo =
      jumphippo ||
      (typeof window !== "undefined" ? window.jumphippo : undefined);
    this.#onSubmit = onSubmit;
    this.#onSaved = onSaved;

    this.#credPicker = new CredentialPickerField({
      jumphippo: this.#jumphippo,
      openKeyFile,
      label: t("editor.credential"),
      onChange: (id) => {
        this.#form.credentialId = id;
        this.#changed();
      },
    });
    this.#jumpPicker = new JumpHostPickerField({
      jumphippo: this.#jumphippo,
      openKeyFile,
      onChange: () => this.#changed(),
    });
    this.#scheduleField = new ScheduleEditorField({
      jumphippo: this.#jumphippo,
      onChange: () => this.#changed(),
      heading: false, // the "Schedule" tab already labels this section
    });

    this.#dialog = new Dialog({
      className: "tunnel-dialog",
      title: t("editor.newTitle"),
      // The editor is split across four tabs so no single panel runs long.
      tabs: [
        { id: "general", label: t("editor.tab.general") },
        { id: "jumps", label: t("editor.tab.jumps") },
        { id: "config", label: t("editor.tab.config") },
        { id: "schedule", label: t("editor.tab.schedule") },
      ],
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
    this.#lockBodyHeight();
  }

  /** Open the editor prefilled from an existing definition. */
  async openEdit(def) {
    await this.#load(def);
    this.#dialog.setTitle(t("editor.editTitle"));
    this.#dialog.open();
    this.#lockBodyHeight();
  }

  /**
   * Open a *create* editor prefilled with a copy of an existing definition
   * (the row context menu's "Clone"). Every value carries over except the name,
   * which is blanked; dropping the id makes the save a create. The name field is
   * focused so the user must name the copy before saving.
   */
  async openClone(def) {
    await this.#load({ ...(def || {}), id: undefined, name: "" });
    this.#dialog.setTitle(t("editor.newTitle"));
    this.#dialog.open();
    this.#lockBodyHeight();
    this.#controls.name?.focus();
  }

  /**
   * Fix the body's height to the General tab so the dialog no longer grows/shrinks
   * when switching tabs — it stays the size the General tab needs. Measured (not a
   * magic constant), so it fits the content at the current UI font/zoom. General is
   * the active panel whenever this runs (dialog open / a type change), so its
   * scrollHeight is the size to lock. A browser-only step: jsdom has no layout, so
   * a zero measurement leaves the dialog content-sized (the prior behaviour).
   */
  #lockBodyHeight() {
    const body = this.#dialog.body;
    if (!body) return;
    body.style.height = ""; // release so scrollHeight reads the natural content
    const needed = body.scrollHeight;
    if (needed > 0) body.style.height = `${needed}px`;
  }

  // ── Form state ──────────────────────────────────────────────────────────────

  async #load(def) {
    const d = def && typeof def === "object" ? def : {};
    this.#editingId = d.id || null;
    this.#showErrors = false;

    const type = normaliseTunnelType(d.type);
    this.#form = {
      name: str(d.name),
      type,
      // Prefer the verbatim strings; reconstruct from the concrete fields for
      // legacy records (or a hand-edited file) that predate them. The Entry / Exit
      // slots are repurposed per type (Feature 110).
      entryAddress: reconstructEntryField(d, type),
      targetServer: reconstructTarget(d),
      exitAddress: reconstructExitField(d, type),
      credentialId: str(d.credentialId),
      jumpHostIds: Array.isArray(d.jumpHostIds) ? d.jumpHostIds : [],
      lingerMs:
        d.lingerMs === undefined || d.lingerMs === null
          ? ""
          : String(d.lingerMs),
      keepAlive: d.keepAlive === true,
      enabled: d.enabled !== false, // default arm-on-startup for a new tunnel
      autoReconnect: d.autoReconnect === true,
      // Feature 130 — the per-tunnel reconnect override (blank = inherit global).
      retryBaseMs: numStr(d.retry?.baseMs),
      retryMaxMs: numStr(d.retry?.maxMs),
      retryMaxAttempts: numStr(d.retry?.maxAttempts),
    };
    for (const [key, input] of Object.entries(this.#controls)) {
      if (input.type === "checkbox") input.checked = this.#form[key];
      else input.value = this.#form[key];
    }
    this.#applyType(); // press the active type + relabel/hide fields for it

    // Load the reference pickers, then apply the stored selection.
    await Promise.all([this.#credPicker.load(), this.#jumpPicker.load()]);
    this.#credPicker.setValue(this.#form.credentialId);
    this.#jumpPicker.setValue(this.#form.jumpHostIds);
    // Feature 150 — the optional per-tunnel schedule (absent ⇒ not scheduled).
    this.#scheduleField.setValue(d.schedule);

    // Existing tunnels for the local-port conflict check.
    this.#existing = (await this.#jumphippo?.tunnels?.list?.()) || [];

    this.#updateEntryWarning();
    this.#resetProbe();
    this.#runResolveCheck(); // prime the local-resolution warnings for this def
    this.#dialog.clearError();
    applyFieldErrors(this.#dialog.body, {});
  }

  /**
   * Assemble the reference-shape payload the store persists: the three raw address
   * strings parsed into concrete fields, plus the verbatim strings for round-trip.
   * A field that fails to parse leaves its concrete value undefined so the
   * validator flags it; the raw string is still sent so nothing the user typed is
   * silently dropped.
   */
  buildPayload() {
    const type = this.#form.type;
    const target = parseTarget(this.#form.targetServer);

    const payload = {
      name: this.#form.name.trim(),
      type,
      // Read the live picker (like jumpHostIds) — it drops a since-deleted id to
      // "", whereas #form.credentialId can retain a stale id the picker rejected.
      credentialId: this.#credPicker.value,
      jumpHostIds: this.#jumpPicker.value,
      keepAlive: this.#form.keepAlive,
      enabled: this.#form.enabled,
      autoReconnect: this.#form.autoReconnect,
    };

    // Target server → the mandatory SSH endpoint for every type. A parse failure
    // leaves sshHost undefined (the validator flags it); port stored only when explicit.
    if (!target.error) {
      payload.sshHost = target.host;
      if (target.port !== undefined) payload.sshPort = target.port;
    }

    const linger = toInt(this.#form.lingerMs);
    if (linger !== undefined) payload.lingerMs = linger;

    // Feature 130 — the per-tunnel reconnect override (all types); omitted when
    // blank so the tunnel inherits the global policy.
    const retry = buildRetryOverride(this.#form);
    if (retry) payload.retry = retry;

    // Feature 150 — the optional schedule (all types); omitted when the user has
    // enabled neither a time nor a network condition.
    const schedule = this.#scheduleField.value;
    if (schedule) payload.schedule = schedule;

    if (type === "dynamic") {
      // Entry slot = the local SOCKS listener. No destination.
      const entry = parseEntry(this.#form.entryAddress);
      payload.localPort = entry.error ? undefined : entry.port;
      const host = entry.error ? undefined : entry.host;
      if (host && !LOOPBACKS.has(host)) payload.bindHost = host;
      payload.entryAddress = this.#form.entryAddress.trim();
      return payload;
    }

    if (type === "remote") {
      // Entry slot = the port bound on the SSH server (parsed like an Entry). Exit
      // slot = the local target the remote port forwards back to.
      const bind = parseEntry(this.#form.entryAddress);
      if (bind.error) {
        payload.remoteBind = { host: undefined, port: undefined };
      } else {
        payload.remoteBind = { port: bind.port };
        if (bind.host && !LOOPBACKS.has(bind.host)) {
          payload.remoteBind.host = bind.host;
        }
      }
      const localTarget = parseExit(this.#form.exitAddress);
      payload.destination = localTarget.error
        ? { host: undefined, port: undefined }
        : { host: localTarget.host ?? LOOPBACK, port: localTarget.port };
      payload.entryAddress = this.#form.entryAddress.trim();
      const exitRaw = this.#form.exitAddress.trim();
      if (exitRaw) payload.exitAddress = exitRaw;
      return payload;
    }

    // local — Entry slot binds the local port; Exit slot is the far destination.
    const entry = parseEntry(this.#form.entryAddress);
    const exit = parseExit(this.#form.exitAddress);
    const entryHost = entry.error ? undefined : entry.host;
    const entryPort = entry.error ? undefined : entry.port;
    payload.localPort = entryPort;
    payload.destination = exit.error
      ? { host: undefined, port: undefined }
      : { host: exit.host ?? LOOPBACK, port: exit.port ?? entryPort };
    // bindHost is only stored when it's a non-default (non-loopback) address; a
    // bare-port Entry leaves it implicit (the resolver defaults it to 127.0.0.1).
    if (entryHost && !LOOPBACKS.has(entryHost)) payload.bindHost = entryHost;
    payload.entryAddress = this.#form.entryAddress.trim();
    const exitRaw = this.#form.exitAddress.trim();
    if (exitRaw) payload.exitAddress = exitRaw;
    return payload;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  #buildBody() {
    this.#entryWarningEl = el("p", {
      class: "editor-port-warning",
      hidden: true,
    });
    this.#entryResolveWarnEl = this.#resolveWarning();
    this.#targetResolveWarnEl = this.#resolveWarning();

    this.#entryField = field({
      label: t("editor.entryPort"),
      control: this.#input(
        "entryAddress",
        t("editor.entryPort.placeholder"),
        "text",
      ),
      errorKey: "entryAddress",
      hint: t("editor.entryPort.hint"),
      description: t("editor.entryPort.desc"),
    });
    this.#exitField = field({
      label: t("editor.exitPort"),
      control: this.#input(
        "exitAddress",
        t("editor.exitPort.placeholder"),
        "text",
      ),
      errorKey: "exitAddress",
      hint: t("editor.exitPort.hint"),
      description: t("editor.exitPort.desc"),
    });
    this.#exitSection = this.#section([this.#exitField]);

    // General — the basic tunnel: name, forwarding type, the three address fields,
    // and the credential. The route-validation block ("Test resolution") lives here
    // too since it checks the route this tab defines.
    this.#dialog.tabBody("general").append(
      // Name (left half) + Forwarding type selector (right half) share one row.
      el("div", { class: "editor-block editor-name-type" }, [
        field({
          label: t("editor.name"),
          control: this.#input("name", "e.g. Prod database", "text"),
          errorKey: "name",
        }),
        field({
          label: t("editor.type"),
          control: this.#buildTypeSelect(),
        }),
      ]),
      el("p", { class: "field-hint editor-type-hint" }),
      this.#section([
        this.#entryField,
        this.#entryWarningEl,
        this.#entryResolveWarnEl,
      ]),
      this.#section([
        field({
          label: t("editor.targetServer"),
          control: this.#input(
            "targetServer",
            t("editor.targetServer.placeholder"),
            "text",
          ),
          errorKey: "targetServer",
          hint: t("editor.targetServer.hint"),
          description: t("editor.targetServer.desc"),
        }),
        this.#targetResolveWarnEl,
      ]),
      this.#exitSection,
      this.#credPicker.element,
    );

    // "Test resolution" sits at the LEFT of the footer; its results open in a
    // separate stacked popup (built once here).
    this.#buildResolvePopup();
    this.#dialog.footerStart.append(this.#buildResolveButton());

    // Jump Hosts — the ordered jump-host chain.
    this.#dialog.tabBody("jumps").append(this.#jumpPicker.element);

    // Config — idle linger, the option toggles, and the per-tunnel reconnect
    // override (Feature 130; blank inherits the global policy).
    this.#dialog.tabBody("config").append(
      this.#section([
        field({
          label: t("editor.linger"),
          control: this.#input("lingerMs", "10000", "number", MS_STEP),
          errorKey: "lingerMs",
          hint: t("editor.linger.hint"),
        }),
        this.#check("enabled", t("editor.enabled")),
        this.#check("keepAlive", t("editor.keepAlive")),
        this.#check("autoReconnect", t("editor.autoReconnect")),
      ]),
      this.#section([
        el("span", { class: "field-label", text: t("editor.retry") }),
        el("p", { class: "field-hint", text: t("editor.retry.hint") }),
        field({
          label: t("editor.retry.baseMs"),
          control: this.#input(
            "retryBaseMs",
            t("editor.retry.inherit"),
            "number",
            MS_STEP,
          ),
          errorKey: "retryBaseMs",
        }),
        field({
          label: t("editor.retry.maxMs"),
          control: this.#input(
            "retryMaxMs",
            t("editor.retry.inherit"),
            "number",
            MS_STEP,
          ),
          errorKey: "retryMaxMs",
        }),
        field({
          label: t("editor.retry.maxAttempts"),
          control: this.#input(
            "retryMaxAttempts",
            t("editor.retry.inherit"),
            "number",
          ),
          errorKey: "retryMaxAttempts",
        }),
      ]),
    );

    // Schedule — the optional time / network auto-arm rule (Feature 150).
    this.#dialog.tabBody("schedule").append(this.#scheduleField.element);
  }

  /** The forwarding-type selector (local / remote / dynamic) as a <select>. */
  #buildTypeSelect() {
    this.#typeSelect = el(
      "select",
      {
        class: "dialog-input editor-input-type",
        onChange: (e) => this.#onTypeChange(e.target.value),
      },
      TYPE_ORDER.map((type) =>
        el("option", { value: type, text: t(`editor.type.${type}`) }),
      ),
    );
    // Registered like the other controls so #load's generic pass sets its value.
    this.#controls.type = this.#typeSelect;
    return this.#typeSelect;
  }

  /** Switch the forwarding type: relabel/hide fields, then revalidate. */
  #onTypeChange(type) {
    if (this.#form.type === type) return;
    this.#form.type = type;
    this.#applyType();
    this.#updateEntryWarning();
    this.#changed();
    // The type governs whether the Exit field shows, so General's height changes;
    // re-fit the dialog to it (General is the active tab when the type changes).
    this.#lockBodyHeight();
  }

  /**
   * Reflect the current forwarding type into the UI: relabel the two repurposed
   * address fields, hide the Exit field for dynamic, and update the type hint. The
   * <select>'s own value already tracks the type (set by #load / user choice).
   */
  #applyType() {
    const type = this.#form.type;
    const cfg = addressFieldConfig(type);
    this.#relabelField(
      this.#entryField,
      cfg.entry,
      this.#controls.entryAddress,
    );
    if (cfg.exit) {
      this.#relabelField(this.#exitField, cfg.exit, this.#controls.exitAddress);
    }
    this.#exitSection.hidden = !cfg.showExit;
    const hint = this.#dialog.body.querySelector(".editor-type-hint");
    if (hint) hint.textContent = t(`editor.type.${type}.desc`);
  }

  /** Update a field wrapper's label / help icon / tooltip + its input placeholder. */
  #relabelField(fieldEl, cfg, input) {
    if (!fieldEl || !cfg) return;
    const labelEl = fieldEl.querySelector(".field-label");
    if (labelEl) labelEl.textContent = cfg.label;
    // Help now lives on the (i) icon beside the label (and the input's tooltip).
    const help = [cfg.hint, cfg.description].filter(Boolean).join("\n\n");
    const infoEl = fieldEl.querySelector(".field-info");
    if (infoEl) {
      infoEl.title = help;
      infoEl.setAttribute("aria-label", help);
    }
    if (input) {
      if (cfg.placeholder !== undefined) input.placeholder = cfg.placeholder;
      input.title = help;
    }
  }

  #section(children) {
    return el("div", { class: "editor-block" }, children);
  }

  #input(key, placeholder, type, extra = {}) {
    const control = el("input", {
      class: `dialog-input editor-input-${key}`,
      type,
      placeholder,
      value: this.#form[key],
      ...extra, // e.g. { step: "1000", min: "0" } for the millisecond fields
      onInput: (e) => {
        this.#form[key] = e.target.value;
        if (key === "entryAddress") this.#updateEntryWarning();
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

  // ── Resolution validation (Feature 100) ──────────────────────────────────────

  #resolveWarning() {
    return el("p", { class: "editor-resolve-warning", hidden: true });
  }

  /** The footer's "Test resolution" button (left-aligned via the dialog's slot). */
  #buildResolveButton() {
    this.#resolveBtn = el("button", {
      type: "button", // never submit the form
      class: "btn btn--secondary editor-resolve-btn",
      text: t("editor.resolve.test"),
      title: t("editor.resolve.hint"),
      onClick: () => this.#onTestResolution(),
    });
    return this.#resolveBtn;
  }

  /**
   * The results popup — its own native <dialog>, so it stacks in the top layer
   * ABOVE the (modal) editor rather than behind it like a PopupManager overlay
   * would. It reuses the editor-dialog chrome (header / body / footer bars). The
   * one footer button is "Cancel test" while a probe runs, else "Close".
   */
  #buildResolvePopup() {
    this.#resolveResultsEl = el("div", { class: "editor-resolve-results" });
    this.#resolveActionBtn = el("button", {
      type: "button",
      class: "btn btn--secondary",
      text: t("common.close"),
      onClick: () => this.#closeResolvePopup(),
    });
    this.#resolvePopup = el(
      "dialog",
      { class: "editor-dialog resolve-popup" },
      [
        el("div", { class: "dialog-header" }, [
          el("h2", { class: "dialog-title", text: t("editor.resolve.test") }),
        ]),
        el("div", { class: "dialog-body" }, [this.#resolveResultsEl]),
        el("div", { class: "dialog-footer" }, [this.#resolveActionBtn]),
      ],
    );
    // Escape closes (and cancels an in-flight probe), like the footer button.
    this.#resolvePopup.addEventListener("cancel", (e) => {
      e.preventDefault();
      this.#closeResolvePopup();
    });
  }

  #openResolvePopup() {
    if (!this.#resolvePopup.isConnected) {
      document.body.appendChild(this.#resolvePopup);
    }
    if (!this.#resolvePopup.open) this.#resolvePopup.showModal();
  }

  /** Close the results popup, cancelling a still-running probe. */
  #closeResolvePopup() {
    if (this.#probeRunning && !this.#probeCancelled) {
      this.#probeCancelled = true;
      this.#jumphippo?.resolve?.cancel?.();
    }
    if (this.#resolvePopup?.open) this.#resolvePopup.close();
  }

  /** Reflect probe-in-flight state onto the popup's action button. */
  #setResolveBusy(busy) {
    this.#resolveActionBtn.textContent = busy
      ? t("editor.resolve.cancel")
      : t("common.close");
  }

  #scheduleResolveCheck() {
    clearTimeout(this.#resolveTimer);
    this.#resolveTimer = setTimeout(
      () => this.#runResolveCheck(),
      RESOLVE_DEBOUNCE_MS,
    );
    // Under Node (tests) this is a Timeout; don't let it keep the loop alive. In a
    // browser it's a number, so the optional chain is a harmless no-op.
    this.#resolveTimer?.unref?.();
  }

  /**
   * Refresh the two local-resolution warnings: the Entry host must name a
   * bindable local address (loopback / wildcard / a local interface), and the
   * Target server must resolve from this machine when it's reached directly (no
   * jump chain). Everything past that — a jumped target, the Exit on the far side
   * — is left to "Test resolution", which walks the real chain.
   */
  async #runResolveCheck() {
    const seq = ++this.#resolveSeq;
    await this.#checkEntryHost(seq);
    if (seq !== this.#resolveSeq) return; // a newer check supersedes this one
    await this.#checkTargetHost(seq);
  }

  async #checkEntryHost(seq) {
    // For remote, the Entry slot is a bind on the SSH server, not a local address,
    // so there is nothing this machine can meaningfully resolve.
    if (this.#form.type === "remote") {
      this.#setResolveWarning(this.#entryResolveWarnEl, "");
      return;
    }
    const entry = parseEntry(this.#form.entryAddress);
    const host = entry.error ? "" : entry.host;
    if (!host || LOOPBACKS.has(host)) {
      this.#setResolveWarning(this.#entryResolveWarnEl, "");
      return;
    }
    let res;
    try {
      res = await this.#jumphippo?.resolve?.bindcheck?.(host);
    } catch {
      res = null;
    }
    if (seq !== this.#resolveSeq) return;
    let message = "";
    if (res && res.resolved === false) {
      message = t("editor.resolve.unresolved", { host });
    } else if (res && res.local === false) {
      message = t("editor.entryPort.notLocal", { host });
    }
    this.#setResolveWarning(this.#entryResolveWarnEl, message);
  }

  async #checkTargetHost(seq) {
    const target = parseTarget(this.#form.targetServer);
    const host = target.error ? "" : target.host;
    const hasJumps = this.#jumpPicker.value.length > 0;
    // With a jump chain the target is reached from the last hop, not locally, so
    // there's nothing this machine can meaningfully check here.
    if (!host || hasJumps || looksLikeIp(host)) {
      this.#setResolveWarning(this.#targetResolveWarnEl, "");
      return;
    }
    let res;
    try {
      res = await this.#jumphippo?.resolve?.lookup?.(host);
    } catch {
      res = null;
    }
    if (seq !== this.#resolveSeq) return;
    const unresolved = Boolean(res) && res.resolved === false;
    this.#setResolveWarning(
      this.#targetResolveWarnEl,
      unresolved ? t("editor.resolve.unresolved", { host }) : "",
    );
  }

  #setResolveWarning(warnEl, message) {
    if (!warnEl) return;
    warnEl.textContent = message;
    warnEl.hidden = message === "";
  }

  async #onTestResolution() {
    if (this.#probeRunning) return; // the footer button is disabled while running
    this.#probeRunning = true;
    this.#probeCancelled = false;
    this.#resolveBtn.disabled = true;
    this.#openResolvePopup();
    this.#setResolveBusy(true);
    this.#renderResolveMessage(t("editor.resolve.testing"));

    let result;
    try {
      result = await this.#jumphippo?.resolve?.test?.(this.buildPayload());
    } catch (err) {
      result = { __hippoError: true, message: err?.message || String(err) };
    }

    this.#probeRunning = false;
    this.#resolveBtn.disabled = false;
    this.#setResolveBusy(false);
    if (this.#probeCancelled) {
      // The user cancelled (footer/Escape/Close already tore the popup down).
      return;
    }
    if (!result || result.__hippoError) {
      this.#renderResolveMessage(
        t("editor.resolve.error", {
          message: (result && (result.message || result.code)) || "",
        }),
        true,
      );
      return;
    }
    this.#renderProbeResult(result);
  }

  #renderProbeResult(result) {
    clear(this.#resolveResultsEl);
    this.#resolveResultsEl.append(
      el("p", {
        class: `editor-resolve-summary${result.ok ? "" : " editor-resolve-summary--warn"}`,
        text: result.ok
          ? t("editor.resolve.allOk")
          : t("editor.resolve.someFailed"),
      }),
    );
    for (const hop of Array.isArray(result.hops) ? result.hops : []) {
      this.#resolveResultsEl.append(
        this.#probeRow(this.#hopFriendly(hop.hopLabel), hop),
      );
    }
    // Only local forwarding probes a far-end destination; remote's destination is
    // a LOCAL target (unreachable from the far end) and dynamic has none.
    if (result.destination && this.#form.type === "local") {
      this.#resolveResultsEl.append(
        this.#probeRow(t("editor.resolve.exitRow"), result.destination),
      );
    }
  }

  #probeRow(label, entry) {
    const status = entry?.status || "skipped";
    const word =
      status === "ok"
        ? t("editor.resolve.ok")
        : status === "fail"
          ? t("editor.resolve.fail")
          : t("editor.resolve.skipped");
    const hostPort = entry?.host
      ? `${entry.host}${entry.port != null ? `:${entry.port}` : ""}`
      : "";
    const statusText = entry?.reason ? `${word} — ${entry.reason}` : word;
    return el(
      "div",
      { class: `editor-resolve-row editor-resolve-row--${status}` },
      [
        el("span", {
          class: "editor-resolve-row-host",
          text: `${label}  ${hostPort}`,
        }),
        el("span", { class: "editor-resolve-row-status", text: statusText }),
      ],
    );
  }

  #hopFriendly(hopLabel) {
    if (hopLabel === "sshServer") return t("editor.resolve.targetRow");
    const m = /^jump\[(\d+)\]$/.exec(hopLabel || "");
    if (m) return t("editor.resolve.jump", { n: Number(m[1]) + 1 });
    return hopLabel || "";
  }

  #renderResolveMessage(text, warn = false) {
    clear(this.#resolveResultsEl);
    this.#resolveResultsEl.append(
      el("p", {
        class: `editor-resolve-summary${warn ? " editor-resolve-summary--warn" : ""}`,
        text,
      }),
    );
  }

  #clearProbeResult() {
    if (this.#probeRunning) return; // never wipe an in-flight run's status
    clear(this.#resolveResultsEl);
  }

  /** Reset the probe between opens: cancel + close the popup, re-enable the button. */
  #resetProbe() {
    this.#closeResolvePopup();
    this.#probeRunning = false;
    this.#probeCancelled = false;
    if (this.#resolveBtn) this.#resolveBtn.disabled = false;
    clear(this.#resolveResultsEl);
  }

  // ── Behaviour ─────────────────────────────────────────────────────────────

  #changed() {
    if (this.#showErrors) this.#revalidate();
    this.#dialog.clearError();
    this.#scheduleResolveCheck();
    this.#clearProbeResult(); // a field edit invalidates the last test
  }

  /** The OS term for the privileged account, chosen from the reported platform. */
  #adminTerm() {
    return this.#jumphippo?.platform === "win32"
      ? t("common.administrator")
      : t("common.root");
  }

  /**
   * Instant soft warning under the Entry slot. For local/dynamic (a local listen
   * port) that's a port conflict or a privileged port; for remote (a bind on the
   * SSH server) it's the GatewayPorts note when the bind isn't loopback.
   */
  #updateEntryWarning() {
    const entry = parseEntry(this.#form.entryAddress);
    let message = "";
    if (this.#form.type === "remote") {
      if (!entry.error && entry.host && !LOOPBACKS.has(entry.host)) {
        message = t("editor.remoteBind.gateway");
      }
    } else if (!entry.error) {
      const port = entry.port;
      const clash = this.#existing.find(
        (d) => d && d.id !== this.#editingId && d.localPort === port,
      );
      if (clash) {
        message = t("editor.localPort.conflict", {
          port,
          name: clash.name || t("def.unnamed"),
        });
      } else if (port < PRIVILEGED_PORT) {
        message = t("editor.entryPort.privileged", {
          admin: this.#adminTerm(),
        });
      }
    }
    this.#entryWarningEl.textContent = message;
    this.#entryWarningEl.hidden = message === "";
  }

  /**
   * Translate structural (concrete-field) validator keys onto the field that owns
   * them, so a `destination.port` error lands on the Exit input rather than a
   * field that no longer exists. Names/refs (name, credentialId, jumpHostIds[i])
   * pass through unchanged.
   */
  #mapConcreteErrors(errors) {
    const out = {};
    for (const [key, message] of Object.entries(errors)) {
      let target = key;
      if (key === "localPort" || key === "bindHost") target = "entryAddress";
      // The remote-bind port lives in the Entry slot for a `remote` tunnel.
      else if (
        key === "remoteBind" ||
        key === "remoteBind.host" ||
        key === "remoteBind.port"
      ) {
        target = "entryAddress";
      } else if (key === "sshHost" || key === "sshPort")
        target = "targetServer";
      else if (
        key === "destination" ||
        key === "destination.host" ||
        key === "destination.port"
      ) {
        target = "exitAddress";
      } else if (key === "retry" || key === "retry.baseMs") {
        target = "retryBaseMs";
      } else if (key === "retry.maxMs") target = "retryMaxMs";
      else if (key === "retry.maxAttempts") target = "retryMaxAttempts";
      if (!out[target]) out[target] = message;
    }
    return out;
  }

  /** Combine per-field parse errors with the remapped structural validator. */
  #computeErrors() {
    const parseErrors = {};
    const entry = parseEntry(this.#form.entryAddress);
    if (entry.error) {
      parseErrors.entryAddress = addressErrorMessage("entry", entry.error);
    }
    const target = parseTarget(this.#form.targetServer);
    if (target.error) {
      parseErrors.targetServer = addressErrorMessage("target", target.error);
    }
    // The Exit field is hidden for dynamic (no fixed destination), so never derive
    // an error from a stale value there.
    if (this.#form.type !== "dynamic") {
      const exit = parseExit(this.#form.exitAddress);
      if (exit.error) {
        parseErrors.exitAddress = addressErrorMessage("exit", exit.error);
      }
    }

    const { errors } = validateDefinition(this.buildPayload());
    const mapped = this.#mapConcreteErrors(errors);
    // A raw parse error is the more precise message, so it wins over the
    // concrete-field fallback for the same field.
    return { ...mapped, ...parseErrors };
  }

  #revalidate() {
    const errors = this.#computeErrors();
    applyFieldErrors(this.#dialog.body, errors);
    return errors;
  }

  async #save() {
    this.#showErrors = true;
    const errors = this.#revalidate();
    if (Object.keys(errors).length > 0) {
      this.#focusErrorTab(errors);
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
        const mapped = this.#mapConcreteErrors(result.errors);
        applyFieldErrors(this.#dialog.body, mapped);
        this.#focusErrorTab(mapped);
      }
      this.#dialog.showError(
        t("editor.saveError", { message: result.message || result.code || "" }),
      );
      return;
    }

    this.#dialog.close();
    this.#onSaved?.(result);
  }

  /** The tab that owns a (remapped) validation-error key. */
  #tabForErrorKey(key) {
    if (key.startsWith("schedule")) return "schedule";
    if (key.startsWith("jumpHostIds")) return "jumps";
    if (key === "lingerMs" || key.startsWith("retry")) return "config";
    return "general"; // name / type / the three address fields / credential
  }

  /**
   * Reveal the tab that owns the failing fields so a validation error is never
   * hidden behind an inactive tab. General problems win over later tabs.
   */
  #focusErrorTab(errors) {
    const owned = new Set(
      Object.keys(errors).map((k) => this.#tabForErrorKey(k)),
    );
    const order = ["general", "jumps", "config", "schedule"];
    const target = order.find((tab) => owned.has(tab));
    if (target) this.#dialog.showTab(target);
  }
}
