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

import { el, clear } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { Dialog } from "../dialog.js";
import { validateDefinition } from "../validate.js";
import { CredentialPickerField } from "./credential-picker-field.js";
import { JumpHostPickerField } from "./jump-host-picker-field.js";

const LOOPBACK = new Set(["", "127.0.0.1", "localhost", "::1"]);
const PRIVILEGED_PORT = 1024;
const RESOLVE_DEBOUNCE_MS = 300;

/** A cheap "already an IP literal" guard so the editor skips a pointless lookup. */
function looksLikeIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

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

  // Feature 100 — hostname resolution. Live local-DNS warnings for the names this
  // machine resolves (bind host + first hop), and the "Test resolution" probe.
  #destResolveWarnEl;
  #bindResolveWarnEl;
  #sshResolveWarnEl;
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
    this.#resetProbe();
    this.#runResolveCheck(); // prime the local-resolution warnings for this def
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
    // Local-resolution warnings sit under the field whose host they concern.
    this.#destResolveWarnEl = this.#resolveWarning();
    this.#bindResolveWarnEl = this.#resolveWarning();
    this.#sshResolveWarnEl = this.#resolveWarning();

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
        this.#bindResolveWarnEl,
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
        this.#sshResolveWarnEl,
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
          label: t("editor.destination.host"),
          control: this.#input("destHost", "db.internal", "text"),
          errorKey: "destination.host",
        }),
        this.#destResolveWarnEl,
      ]),
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

  /**
   * The host fields this machine resolves directly — always the bind host, plus the
   * chain's first hop when that hop is one of this dialog's own text fields (a jump
   * host is a separate record, so with a jump chain the downstream hosts are left to
   * Test resolution). Every warning element appears so each run fully rewrites them.
   */
  #localResolveTargets() {
    const targets = [
      { el: this.#bindResolveWarnEl, host: this.#form.bindHost.trim() },
    ];
    const hasJumps = this.#jumpPicker.value.length > 0;
    const ssh = this.#form.sshHost.trim();
    if (hasJumps) {
      // First hop is a jump host → validated by Test; nothing local to flag here.
      targets.push({ el: this.#destResolveWarnEl, host: "" });
      targets.push({ el: this.#sshResolveWarnEl, host: "" });
    } else if (ssh) {
      // Bastion: SSH server is the first (local) hop; the destination is remote.
      targets.push({ el: this.#sshResolveWarnEl, host: ssh });
      targets.push({ el: this.#destResolveWarnEl, host: "" });
    } else {
      // No bastion: we SSH straight into the destination box, so it's the first hop.
      targets.push({
        el: this.#destResolveWarnEl,
        host: this.#form.destHost.trim(),
      });
      targets.push({ el: this.#sshResolveWarnEl, host: "" });
    }
    return targets;
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

  async #runResolveCheck() {
    const seq = ++this.#resolveSeq;
    for (const { el: warnEl, host } of this.#localResolveTargets()) {
      if (!warnEl) continue;
      if (!host || looksLikeIp(host)) {
        this.#setResolveWarning(warnEl, "");
        continue;
      }
      let res;
      try {
        res = await this.#porthippo?.resolve?.lookup?.(host);
      } catch {
        res = null;
      }
      if (seq !== this.#resolveSeq) return; // a newer check supersedes this one
      const unresolved = Boolean(res) && res.resolved === false;
      this.#setResolveWarning(
        warnEl,
        unresolved ? t("editor.resolve.unresolved", { host }) : "",
      );
    }
  }

  #setResolveWarning(warnEl, message) {
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
        this.#probeRow(t("editor.resolve.destinationRow"), result.destination),
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
    if (hopLabel === "sshServer") return t("editor.resolve.sshServer");
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
