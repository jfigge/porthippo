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

// tunnel-editor-dialog.js — create/edit a tunnel in a native <dialog>. The body
// reads as the path a connection takes: Name, then three free-text address:port
// fields — Entry port (the local listener), Target server (the remote SSH box),
// Exit port (the address forwarded to on that box) — then the Credential, and an
// Advanced <details> for the jump-host chain, idle linger and option toggles.
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
import { validateDefinition } from "../validate.js";
import {
  parseEntry,
  parseTarget,
  parseExit,
  PRIVILEGED_PORT,
  LOOPBACK,
} from "../address.js";
import { CredentialPickerField } from "./credential-picker-field.js";
import { JumpHostPickerField } from "./jump-host-picker-field.js";

/** Hosts that always mean "this machine's loopback" — no bind/resolve warning. */
const LOOPBACKS = new Set(["", "127.0.0.1", "localhost", "::1"]);
const RESOLVE_DEBOUNCE_MS = 300;

/** A cheap "already an IP literal" guard so the editor skips a pointless lookup. */
function looksLikeIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

function toInt(str) {
  const s = String(str).trim();
  if (s === "") return undefined;
  return Number(s);
}

/** Map an address.js parse-error code to an inline field message. */
function addressErrorMessage(fieldName, code) {
  if (code === "port_range") return t("editor.address.portRange");
  if (fieldName === "entry") {
    return code === "no_port"
      ? t("editor.address.entryNoPort")
      : t("editor.address.entryRequired");
  }
  if (fieldName === "target") return t("editor.address.targetRequired");
  return t("editor.address.portRange");
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
  #entryWarningEl; // privileged-port / port-conflict (instant, soft)
  #entryResolveWarnEl; // Entry host not a bindable local address (debounced)
  #targetResolveWarnEl; // Target server doesn't resolve locally (debounced)
  #editingId = null;
  #showErrors = false;
  #existing = []; // other tunnels, for the local-port conflict warning

  // Feature 100 — the "Test resolution" probe (walks the real chain).
  #resolveBtn;
  #resolveResultsEl;
  #resolveTimer = null;
  #resolveSeq = 0; // guards against a stale debounced check applying late
  #probeRunning = false;
  #probeCancelled = false;

  /**
   * @param {object} opts
   * @param {object} [opts.porthippo]  IPC bridge (defaults to window.porthippo)
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   * @param {(payload: object, ctx: { id: string|null }) => Promise<object>} opts.onSubmit
   *        performs the store write and resolves to the record or a `{ __hippoError }`.
   * @param {(record: object) => void} [opts.onSaved]  fires after a successful write.
   */
  constructor({ porthippo, openKeyFile, onSubmit, onSaved } = {}) {
    this.#porthippo =
      porthippo ||
      (typeof window !== "undefined" ? window.porthippo : undefined);
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
    this.#controls.name?.focus();
  }

  // ── Form state ──────────────────────────────────────────────────────────────

  async #load(def) {
    const d = def && typeof def === "object" ? def : {};
    this.#editingId = d.id || null;
    this.#showErrors = false;

    this.#form = {
      name: str(d.name),
      // Prefer the verbatim strings; reconstruct from the concrete fields for
      // legacy records (or a hand-edited file) that predate them.
      entryAddress: str(d.entryAddress) || reconstructEntry(d),
      targetServer: reconstructTarget(d),
      exitAddress: str(d.exitAddress) || reconstructExit(d),
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

    this.#updateEntryWarning();
    this.#resetProbe();
    this.#runResolveCheck(); // prime the local-resolution warnings for this def
    this.#dialog.clearError();
    applyFieldErrors(this.#dialog.body, {});
  }

  #usesAdvanced() {
    return Boolean(
      this.#form.jumpHostIds.length ||
      this.#form.keepAlive ||
      this.#form.autoReconnect ||
      this.#form.lingerMs !== "",
    );
  }

  /**
   * Assemble the reference-shape payload the store persists: the three raw address
   * strings parsed into concrete fields, plus the verbatim strings for round-trip.
   * A field that fails to parse leaves its concrete value undefined so the
   * validator flags it; the raw string is still sent so nothing the user typed is
   * silently dropped.
   */
  buildPayload() {
    const entry = parseEntry(this.#form.entryAddress);
    const target = parseTarget(this.#form.targetServer);
    const exit = parseExit(this.#form.exitAddress);

    const entryHost = entry.error ? undefined : entry.host;
    const entryPort = entry.error ? undefined : entry.port;

    const payload = {
      name: this.#form.name.trim(),
      localPort: entryPort,
      destination: exit.error
        ? { host: undefined, port: undefined }
        : { host: exit.host ?? LOOPBACK, port: exit.port ?? entryPort },
      // Read the live picker (like jumpHostIds) — it drops a since-deleted id to
      // "", whereas #form.credentialId can retain a stale id the picker rejected.
      credentialId: this.#credPicker.value,
      jumpHostIds: this.#jumpPicker.value,
      keepAlive: this.#form.keepAlive,
      enabled: this.#form.enabled,
      autoReconnect: this.#form.autoReconnect,
      entryAddress: this.#form.entryAddress.trim(),
    };

    // bindHost is only stored when it's a non-default (non-loopback) address; a
    // bare-port Entry leaves it implicit (the resolver defaults it to 127.0.0.1).
    if (entryHost && !LOOPBACKS.has(entryHost)) payload.bindHost = entryHost;

    // Target server → the mandatory SSH endpoint. A parse failure leaves sshHost
    // undefined (the validator flags it); the port is stored only when explicit.
    if (!target.error) {
      payload.sshHost = target.host;
      if (target.port !== undefined) payload.sshPort = target.port;
    }

    // Exit raw echo — stored only when the user actually typed something (a blank
    // Exit reconstructs from the loopback default on reload).
    const exitRaw = this.#form.exitAddress.trim();
    if (exitRaw) payload.exitAddress = exitRaw;

    const linger = toInt(this.#form.lingerMs);
    if (linger !== undefined) payload.lingerMs = linger;
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

    this.#detailsEl = el("details", { class: "editor-advanced" }, [
      el("summary", {
        class: "editor-advanced-summary",
        text: t("editor.advanced"),
      }),
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
      this.#buildResolveBlock(),
    ]);

    this.#dialog.body.append(
      field({
        label: t("editor.name"),
        control: this.#input("name", "e.g. Prod database", "text"),
        errorKey: "name",
      }),
      this.#section([
        field({
          label: t("editor.entryPort"),
          control: this.#input(
            "entryAddress",
            t("editor.entryPort.placeholder"),
            "text",
          ),
          errorKey: "entryAddress",
          hint: t("editor.entryPort.hint"),
          description: t("editor.entryPort.desc"),
        }),
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
      this.#section([
        field({
          label: t("editor.exitPort"),
          control: this.#input(
            "exitAddress",
            t("editor.exitPort.placeholder"),
            "text",
          ),
          errorKey: "exitAddress",
          hint: t("editor.exitPort.hint"),
          description: t("editor.exitPort.desc"),
        }),
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

  #buildResolveBlock() {
    this.#resolveBtn = el("button", {
      type: "button", // never submit the form
      class: "btn btn--secondary editor-resolve-btn",
      text: t("editor.resolve.test"),
      onClick: () => this.#onTestResolution(),
    });
    this.#resolveResultsEl = el("div", {
      class: "editor-resolve-results",
      hidden: true,
    });
    return el("div", { class: "editor-block editor-resolve" }, [
      this.#resolveBtn,
      el("p", {
        class: "field-hint editor-resolve-hint",
        text: t("editor.resolve.hint"),
      }),
      this.#resolveResultsEl,
    ]);
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
    const entry = parseEntry(this.#form.entryAddress);
    const host = entry.error ? "" : entry.host;
    if (!host || LOOPBACKS.has(host)) {
      this.#setResolveWarning(this.#entryResolveWarnEl, "");
      return;
    }
    let res;
    try {
      res = await this.#porthippo?.resolve?.bindcheck?.(host);
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
      res = await this.#porthippo?.resolve?.lookup?.(host);
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
    if (this.#probeRunning) {
      // The button doubles as Cancel while a test is running.
      this.#probeCancelled = true;
      this.#porthippo?.resolve?.cancel?.();
      return;
    }
    this.#probeRunning = true;
    this.#probeCancelled = false;
    this.#resolveBtn.textContent = t("editor.resolve.cancel");
    this.#renderResolveMessage(t("editor.resolve.testing"));

    let result;
    try {
      result = await this.#porthippo?.resolve?.test?.(this.buildPayload());
    } catch (err) {
      result = { __hippoError: true, message: err?.message || String(err) };
    }

    this.#probeRunning = false;
    this.#resolveBtn.textContent = t("editor.resolve.test");
    if (this.#probeCancelled) {
      this.#clearProbeResult();
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
    this.#resolveResultsEl.hidden = false;
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
    if (result.destination) {
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
    this.#resolveResultsEl.hidden = false;
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
    this.#resolveResultsEl.hidden = true;
  }

  #resetProbe() {
    if (this.#probeRunning) this.#porthippo?.resolve?.cancel?.();
    this.#probeRunning = false;
    this.#probeCancelled = false;
    if (this.#resolveBtn)
      this.#resolveBtn.textContent = t("editor.resolve.test");
    clear(this.#resolveResultsEl);
    this.#resolveResultsEl.hidden = true;
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
    return this.#porthippo?.platform === "win32"
      ? t("common.administrator")
      : t("common.root");
  }

  /** Instant soft warning under Entry: a port conflict, or a privileged port. */
  #updateEntryWarning() {
    const entry = parseEntry(this.#form.entryAddress);
    let message = "";
    if (!entry.error) {
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
      else if (key === "sshHost" || key === "sshPort") target = "targetServer";
      else if (
        key === "destination" ||
        key === "destination.host" ||
        key === "destination.port"
      ) {
        target = "exitAddress";
      }
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
    const exit = parseExit(this.#form.exitAddress);
    if (exit.error) {
      parseErrors.exitAddress = addressErrorMessage("exit", exit.error);
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
        const mapped = this.#mapConcreteErrors(result.errors);
        applyFieldErrors(this.#dialog.body, mapped);
        if (this.#hasAdvancedError(mapped)) this.#detailsEl.open = true;
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
      (k) => k === "lingerMs" || k.startsWith("jumpHostIds"),
    );
  }
}

// ── Blank-state helpers ───────────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v : "";
}

/** Rebuild the Entry field from a stored def: "port" or "host:port". */
function reconstructEntry(d) {
  const port = d.localPort;
  if (port === undefined || port === null) return "";
  const host = str(d.bindHost).trim();
  return host === "" || LOOPBACKS.has(host) ? String(port) : `${host}:${port}`;
}

/** Rebuild the Target field: "host" or "host:port" (22 elided). */
function reconstructTarget(d) {
  const host = str(d.sshHost).trim();
  if (host === "") {
    // Legacy blank sshHost: the box SSH'd into was the destination host itself.
    return str(d.destination?.host).trim();
  }
  const port = d.sshPort;
  return port === undefined || port === null || port === 22
    ? host
    : `${host}:${port}`;
}

/** Rebuild the Exit field, collapsing the loopback + entry-port default to "". */
function reconstructExit(d) {
  const port = d.destination?.port;
  if (port === undefined || port === null) return "";
  // Legacy blank sshHost forwarded to loopback:destPort on the destination box.
  if (str(d.sshHost).trim() === "") {
    return port === d.localPort ? "" : String(port);
  }
  const host = str(d.destination?.host).trim();
  const loopback = host === "" || LOOPBACKS.has(host);
  if (loopback) return port === d.localPort ? "" : String(port);
  return `${host}:${port}`;
}

function blankForm() {
  return {
    name: "",
    entryAddress: "",
    targetServer: "",
    exitAddress: "",
    credentialId: "",
    jumpHostIds: [],
    lingerMs: "",
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
  };
}
