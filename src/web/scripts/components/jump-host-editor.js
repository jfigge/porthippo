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

// jump-host-editor.js — the ordered jump-host chain. Zero rows = a direct
// connection; each row is a HopEditor (host/port/user + auth) identical in shape
// to the terminating server, and the row order IS the hop order. Add / remove /
// move up / move down mutate the chain and re-emit the whole `jumps[]` array via
// the `onChange` callback. HopEditor instances persist across reorders (their DOM
// nodes are relocated, not rebuilt) so in-progress input is never lost; only the
// error-key prefixes and hop numbers are re-derived from position.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { HopEditor } from "./hop-editor.js";

/** A fresh jump host: SSH default port, agent auth, everything else blank. */
function blankHop() {
  return { host: "", port: 22, user: "", auth: [{ type: "agent" }] };
}

export class JumpHostEditor {
  #el;
  #listEl;
  #emptyEl;
  #hops = []; // HopEditor[]
  #onChange;
  #openKeyFile;

  /**
   * @param {object} opts
   * @param {(jumps: object[]) => void} [opts.onChange]
   * @param {() => Promise<string|null>} [opts.openKeyFile]
   */
  constructor({ onChange, openKeyFile } = {}) {
    this.#onChange = onChange;
    this.#openKeyFile = openKeyFile;
    this.#el = this.#build();
    this.#renderList();
  }

  get element() {
    return this.#el;
  }

  /** Replace the chain. Does not fire onChange. */
  setValue(jumps) {
    for (const hop of this.#hops) hop.destroy();
    const list = Array.isArray(jumps) ? jumps : [];
    this.#hops = list.map((hop, i) => this.#makeHop(hop, i));
    this.#renderList();
  }

  /** The current ordered `jumps[]` array. */
  getValue() {
    return this.#hops.map((hop) => hop.getValue());
  }

  destroy() {
    for (const hop of this.#hops) hop.destroy();
    this.#hops = [];
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  #makeHop(value, index) {
    const hop = new HopEditor({
      pathPrefix: `jumps[${index}]`,
      openKeyFile: this.#openKeyFile,
      onChange: () => this.#emit(),
    });
    hop.setValue(value);
    return hop;
  }

  #build() {
    this.#listEl = el("div", { class: "jumps-list" });
    this.#emptyEl = el("p", { class: "jumps-empty", text: t("jumps.empty") });
    return el("div", { class: "jump-host-editor" }, [
      el("div", { class: "jumps-header" }, [
        el("span", { class: "jumps-header-title", text: t("editor.jumps") }),
        el("button", {
          class: "btn btn--ghost jumps-add-btn",
          type: "button",
          text: t("jumps.add"),
          onClick: () => this.#add(),
        }),
      ]),
      this.#emptyEl,
      this.#listEl,
    ]);
  }

  #renderList() {
    clear(this.#listEl);
    this.#emptyEl.hidden = this.#hops.length > 0;

    this.#hops.forEach((hop, index) => {
      hop.setPathPrefix(`jumps[${index}]`);
      this.#listEl.appendChild(this.#renderRow(hop, index));
    });
  }

  #renderRow(hop, index) {
    return el("div", { class: "jump-host" }, [
      el("div", { class: "jump-host-head" }, [
        el("span", {
          class: "jump-host-title",
          text: t("jumps.label", { n: index + 1 }),
        }),
        el("div", { class: "jump-host-tools" }, [
          this.#toolBtn(t("jumps.moveUp"), "↑", index === 0, () =>
            this.#move(index, -1),
          ),
          this.#toolBtn(
            t("jumps.moveDown"),
            "↓",
            index === this.#hops.length - 1,
            () => this.#move(index, 1),
          ),
          this.#toolBtn(
            t("jumps.remove"),
            "✕",
            false,
            () => this.#remove(index),
            "jump-remove-btn",
          ),
        ]),
      ]),
      hop.element,
    ]);
  }

  #toolBtn(label, glyph, disabled, onClick, extraClass = "") {
    return el("button", {
      class: `btn btn--icon jump-tool-btn ${extraClass}`.trim(),
      type: "button",
      title: label,
      "aria-label": label,
      text: glyph,
      disabled,
      onClick,
    });
  }

  #add() {
    this.#hops.push(this.#makeHop(blankHop(), this.#hops.length));
    this.#renderList();
    this.#emit();
  }

  #remove(index) {
    const [hop] = this.#hops.splice(index, 1);
    hop?.destroy();
    this.#renderList();
    this.#emit();
  }

  #move(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= this.#hops.length) return;
    const [hop] = this.#hops.splice(index, 1);
    this.#hops.splice(to, 0, hop);
    this.#renderList();
    this.#emit();
  }

  #emit() {
    this.#onChange?.(this.getValue());
  }
}
