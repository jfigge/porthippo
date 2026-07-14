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

// card-menu.js — the "Cards" checklist dropdown, shared by the detail cards view
// (choose which cards show) and the list view (choose which columns show). A
// button toggles a checklist of every catalogue card; checking/unchecking one is
// reported to the owner via `onToggle(key, checked)`. The owner keeps the visible
// set and its order — the menu just reflects it (via `sync`) and reports intents.
// It closes itself on an outside pointer-down / Escape.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { DEFAULT_CARD_ORDER, cardLabel } from "./card-catalog.js";

export class CardMenu {
  #wrap;
  #btn;
  #menu;
  #boxes = new Map(); // card key → checkbox input
  #open = false;
  #visible;
  #onToggle;
  #onDocPointerDown;
  #onKeydown;

  /**
   * @param {object} opts
   * @param {() => string[]} [opts.visible]  current visible keys (synced on open)
   * @param {(key:string, checked:boolean) => void} [opts.onToggle]
   * @param {string} [opts.buttonLabelKey]  i18n key for the button text
   * @param {string} [opts.titleKey]         i18n key for the menu heading
   * @param {string} [opts.tooltipKey]       i18n key for the button title/tooltip
   */
  constructor({
    visible,
    onToggle,
    buttonLabelKey = "detail.cards",
    titleKey = "detail.cards.menuTitle",
    tooltipKey = "detail.cards.title",
  } = {}) {
    this.#visible = visible || (() => []);
    this.#onToggle = onToggle || (() => {});
    this.#onDocPointerDown = (e) => {
      if (this.#open && !this.#wrap.contains(e.target)) this.close();
    };
    this.#onKeydown = (e) => {
      if (e.key === "Escape") this.close();
    };
    this.#build(buttonLabelKey, titleKey, tooltipKey);
  }

  /** The anchored wrapper (button + menu); drop it into a controls row. */
  get element() {
    return this.#wrap;
  }

  get isOpen() {
    return this.#open;
  }

  #build(buttonLabelKey, titleKey, tooltipKey) {
    this.#btn = el("button", {
      class: "detail-ctrl detail-cards-btn",
      type: "button",
      title: t(tooltipKey),
      "aria-haspopup": "true",
      "aria-expanded": "false",
      onClick: (e) => {
        e.stopPropagation();
        this.#toggle();
      },
    });
    this.#btn.append(
      document.createTextNode(t(buttonLabelKey)),
      el("span", { class: "detail-cards-caret", html: icons.chevronDown() }),
    );

    const items = DEFAULT_CARD_ORDER.map((key) => {
      const box = el("input", {
        type: "checkbox",
        class: "card-menu-check",
        dataset: { card: key },
        onChange: (e) => this.#onToggle(key, e.target.checked),
      });
      this.#boxes.set(key, box);
      return el("label", { class: "card-menu-item" }, [
        box,
        el("span", { class: "card-menu-label", text: cardLabel(key) }),
      ]);
    });

    this.#menu = el("div", { class: "card-menu", role: "menu", hidden: true }, [
      el("div", { class: "card-menu-title", text: t(titleKey) }),
      el("div", { class: "card-menu-grid" }, items),
    ]);

    this.#wrap = el("div", { class: "detail-cards-menu-wrap" }, [
      this.#btn,
      this.#menu,
    ]);
  }

  /** Reflect a visible set onto the checkboxes (checked = shown). */
  sync(visibleKeys) {
    const shown = new Set(visibleKeys);
    for (const [key, box] of this.#boxes) box.checked = shown.has(key);
  }

  #toggle() {
    if (this.#open) this.close();
    else this.open();
  }

  open() {
    this.sync(this.#visible());
    this.#open = true;
    this.#menu.hidden = false;
    this.#btn.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.#onDocPointerDown, true);
    document.addEventListener("keydown", this.#onKeydown);
  }

  close() {
    this.#open = false;
    this.#menu.hidden = true;
    this.#btn.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.#onDocPointerDown, true);
    document.removeEventListener("keydown", this.#onKeydown);
  }
}
