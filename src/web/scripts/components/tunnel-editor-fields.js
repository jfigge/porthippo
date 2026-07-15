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

// tunnel-editor-fields.js — the pure, stateless field helpers for the tunnel
// editor: the per-forwarding-type address-field labels, small parse/format
// utilities, and the routines that rebuild each free-text address field from a
// stored definition (and the blank-form factory). Split out of
// tunnel-editor-dialog.js so the dialog keeps only its DOM + lifecycle; nothing
// here touches component state, so it's trivially unit-testable in isolation.

import { t } from "../i18n.js";

/** Hosts that always mean "this machine's loopback" — no bind/resolve warning. */
export const LOOPBACKS = new Set(["", "127.0.0.1", "localhost", "::1"]);

/** The forwarding types offered by the segmented control, in display order. */
export const TYPE_ORDER = ["local", "remote", "dynamic"];

/**
 * The label / hint / placeholder / tooltip for the two repurposed address fields
 * per forwarding type (Feature 110). The Target-server field is identical across
 * types, so it's not listed here. `showExit` hides the second field for dynamic,
 * which has no fixed destination.
 */
export function addressFieldConfig(type) {
  if (type === "remote") {
    return {
      entry: {
        label: t("editor.remoteBind"),
        placeholder: t("editor.remoteBind.placeholder"),
        hint: t("editor.remoteBind.hint"),
        description: t("editor.remoteBind.desc"),
      },
      exit: {
        label: t("editor.localTarget"),
        placeholder: t("editor.localTarget.placeholder"),
        hint: t("editor.localTarget.hint"),
        description: t("editor.localTarget.desc"),
      },
      showExit: true,
    };
  }
  if (type === "dynamic") {
    return {
      entry: {
        label: t("editor.socksPort"),
        placeholder: t("editor.socksPort.placeholder"),
        hint: t("editor.socksPort.hint"),
        description: t("editor.socksPort.desc"),
      },
      showExit: false,
    };
  }
  return {
    entry: {
      label: t("editor.entryPort"),
      placeholder: t("editor.entryPort.placeholder"),
      hint: t("editor.entryPort.hint"),
      description: t("editor.entryPort.desc"),
    },
    exit: {
      label: t("editor.exitPort"),
      placeholder: t("editor.exitPort.placeholder"),
      hint: t("editor.exitPort.hint"),
      description: t("editor.exitPort.desc"),
    },
    showExit: true,
  };
}

/** A cheap "already an IP literal" guard so the editor skips a pointless lookup. */
export function looksLikeIp(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

export function toInt(str) {
  const s = String(str).trim();
  if (s === "") return undefined;
  return Number(s);
}

/** Map an address.js parse-error code to an inline field message. */
export function addressErrorMessage(fieldName, code) {
  if (code === "port_range") return t("editor.address.portRange");
  if (fieldName === "entry") {
    return code === "no_port"
      ? t("editor.address.entryNoPort")
      : t("editor.address.entryRequired");
  }
  if (fieldName === "target") return t("editor.address.targetRequired");
  return t("editor.address.portRange");
}

// ── Blank-state + address reconstruction ──────────────────────────────────────

export function str(v) {
  return typeof v === "string" ? v : "";
}

/** Rebuild the Remote-bind field: "port" or "host:port" (loopback host elided). */
function reconstructRemoteBind(d) {
  const port = d.remoteBind?.port;
  if (port === undefined || port === null) return "";
  const host = str(d.remoteBind?.host).trim();
  return host === "" || LOOPBACKS.has(host) ? String(port) : `${host}:${port}`;
}

/** Rebuild the Local-target field (remote's destination): "port" or "host:port". */
function reconstructLocalTarget(d) {
  const port = d.destination?.port;
  if (port === undefined || port === null) return "";
  const host = str(d.destination?.host).trim();
  return host === "" || LOOPBACKS.has(host) ? String(port) : `${host}:${port}`;
}

/** Rebuild the Entry field from a stored def: "port" or "host:port". */
function reconstructEntry(d) {
  const port = d.localPort;
  if (port === undefined || port === null) return "";
  const host = str(d.bindHost).trim();
  return host === "" || LOOPBACKS.has(host) ? String(port) : `${host}:${port}`;
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

/** Rebuild the Entry-slot text for the given type from a stored def. */
export function reconstructEntryField(d, type) {
  if (type === "remote") return str(d.entryAddress) || reconstructRemoteBind(d);
  return str(d.entryAddress) || reconstructEntry(d);
}

/** Rebuild the Exit-slot text for the given type (dynamic has no Exit field). */
export function reconstructExitField(d, type) {
  if (type === "dynamic") return "";
  if (type === "remote") return str(d.exitAddress) || reconstructLocalTarget(d);
  return str(d.exitAddress) || reconstructExit(d);
}

/** Rebuild the Target field: "host" or "host:port" (22 elided). */
export function reconstructTarget(d) {
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

export function blankForm() {
  return {
    name: "",
    type: "local",
    entryAddress: "",
    targetServer: "",
    exitAddress: "",
    credentialId: "",
    jumpHostIds: [],
    lingerMs: "",
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
    // Feature 130 — the optional per-tunnel reconnect-policy override. Blank means
    // "inherit the global setting"; each field is independent.
    retryBaseMs: "",
    retryMaxMs: "",
    retryMaxAttempts: "",
  };
}

/**
 * Fold the three raw retry-override strings into a `retry` object for the payload,
 * or `undefined` when all three are blank (inherit the global setting). Each field
 * is omitted individually when blank so a partial override is preserved.
 * @param {{retryBaseMs:string, retryMaxMs:string, retryMaxAttempts:string}} form
 * @returns {object|undefined}
 */
export function buildRetryOverride(form) {
  const retry = {};
  const base = toInt(form.retryBaseMs);
  const max = toInt(form.retryMaxMs);
  const attempts = toInt(form.retryMaxAttempts);
  if (base !== undefined) retry.baseMs = base;
  if (max !== undefined) retry.maxMs = max;
  if (attempts !== undefined) retry.maxAttempts = attempts;
  return Object.keys(retry).length ? retry : undefined;
}
