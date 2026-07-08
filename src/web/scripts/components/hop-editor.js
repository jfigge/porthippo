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

// hop-editor.js — one SSH hop: host / port / user + its AuthEditor. A hop has the
// same shape whether it's the tunnel-terminating server or a jump host, so this
// single component is reused for both (by TunnelEditor for `sshServer`, by
// JumpHostEditor for each `jumps[]` entry). Built once and updated in place;
// `setPathPrefix` retargets the field error keys when a jump host is reordered.

import { el } from "../dom.js";
import { field, setFieldErrorKey } from "../field.js";
import { t } from "../i18n.js";
import { AuthEditor } from "./auth-editor.js";

/** Parse a port input into a number (undefined when blank) for validation. */
function toPort(str) {
  const s = String(str).trim();
  if (s === "") return undefined;
  return Number(s);
}

export class HopEditor {
  #el;
  #hop = { host: "", port: "", user: "" };
  #fields = {}; // { host, port, user } → the .field wrappers (for error-key retarget)
  #auth;
  #pathPrefix;
  #onChange;

  /**
   * @param {object} opts
   * @param {(hop: object) => void} [opts.onChange]
   * @param {string} [opts.pathPrefix]  e.g. "sshServer" or "jumps[0]"
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ onChange, pathPrefix = "sshServer", openKeyFile } = {}) {
    this.#onChange = onChange;
    this.#pathPrefix = pathPrefix;
    this.#auth = new AuthEditor({
      pathPrefix: `${pathPrefix}.auth`,
      openKeyFile,
      onChange: () => this.#emit(),
    });
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  setValue(hop) {
    const h = hop && typeof hop === "object" ? hop : {};
    this.#hop = {
      host: typeof h.host === "string" ? h.host : "",
      port: h.port === undefined || h.port === null ? "" : String(h.port),
      user: typeof h.user === "string" ? h.user : "",
    };
    this.#fields.host.control.value = this.#hop.host;
    this.#fields.port.control.value = this.#hop.port;
    this.#fields.user.control.value = this.#hop.user;
    this.#auth.setValue(h.auth);
  }

  getValue() {
    return {
      host: this.#hop.host.trim(),
      port: toPort(this.#hop.port),
      user: this.#hop.user.trim(),
      auth: this.#auth.getValue(),
    };
  }

  /** Retarget field error keys (host/port/user + the nested auth) to `prefix`. */
  setPathPrefix(prefix) {
    if (prefix === this.#pathPrefix) return;
    this.#pathPrefix = prefix;
    setFieldErrorKey(this.#fields.host.wrapper, `${prefix}.host`);
    setFieldErrorKey(this.#fields.port.wrapper, `${prefix}.port`);
    setFieldErrorKey(this.#fields.user.wrapper, `${prefix}.user`);
    this.#auth.setPathPrefix(`${prefix}.auth`);
  }

  destroy() {
    this.#auth.destroy();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #build() {
    const host = this.#textField("host", t("hop.host"), "hostname or IP");
    const port = this.#textField("port", t("hop.port"), "22", "number");
    const user = this.#textField("user", t("hop.user"), "username");

    return el("div", { class: "hop-editor" }, [
      el("div", { class: "hop-editor-grid" }, [
        host.wrapper,
        port.wrapper,
        user.wrapper,
      ]),
      this.#auth.element,
    ]);
  }

  #textField(key, label, placeholder, type = "text") {
    const control = el("input", {
      class: `hop-input hop-input-${key}`,
      type,
      value: this.#hop[key],
      placeholder,
      "aria-label": label,
      onInput: (e) => {
        this.#hop[key] = e.target.value;
        this.#emit();
      },
    });
    const wrapper = field({
      label,
      control,
      errorKey: `${this.#pathPrefix}.${key}`,
      className: `hop-field hop-field-${key}`,
    });
    this.#fields[key] = { wrapper, control };
    return { wrapper, control };
  }

  #emit() {
    this.#onChange?.(this.getValue());
  }
}
