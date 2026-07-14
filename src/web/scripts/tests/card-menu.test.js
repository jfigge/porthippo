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

// card-menu.test.js — the shared "Cards" checklist dropdown: the button toggles
// the menu, `sync` reflects a visible set onto the checkboxes, checking a box
// reports (key, checked), and an outside pointer-down / Escape closes it.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { CardMenu } from "../components/card-menu.js";
import { DEFAULT_CARD_ORDER } from "../components/card-catalog.js";

function mount(visible = [...DEFAULT_CARD_ORDER]) {
  resetDom();
  const toggles = [];
  const state = { visible };
  const menu = new CardMenu({
    visible: () => state.visible,
    onToggle: (key, checked) => toggles.push({ key, checked }),
  });
  document.body.appendChild(menu.element);
  return { menu, toggles, state };
}

const btn = (menu) => menu.element.querySelector(".detail-cards-btn");
const panel = (menu) => menu.element.querySelector(".card-menu");
const box = (menu, key) =>
  menu.element.querySelector(`.card-menu-check[data-card="${key}"]`);

test("the menu starts closed and a checkbox exists for every card", () => {
  const { menu } = mount();
  assert.equal(panel(menu).hidden, true);
  assert.equal(
    menu.element.querySelectorAll(".card-menu-check").length,
    DEFAULT_CARD_ORDER.length,
  );
});

test("clicking the button opens the menu and syncs the visible set", () => {
  const { menu } = mount(["download", "errors"]);
  btn(menu).click();
  assert.equal(panel(menu).hidden, false);
  assert.equal(menu.isOpen, true);
  // Only the visible cards are checked.
  assert.equal(box(menu, "download").checked, true);
  assert.equal(box(menu, "errors").checked, true);
  assert.equal(box(menu, "upload").checked, false);
});

test("toggling a checkbox reports (key, checked)", () => {
  const { menu, toggles } = mount(["download"]);
  btn(menu).click();
  const upload = box(menu, "upload");
  upload.checked = true;
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(toggles.at(-1), { key: "upload", checked: true });

  const download = box(menu, "download");
  download.checked = false;
  download.dispatchEvent(new Event("change", { bubbles: true }));
  assert.deepEqual(toggles.at(-1), { key: "download", checked: false });
});

test("an outside pointer-down closes the menu", () => {
  const { menu } = mount();
  btn(menu).click();
  assert.equal(menu.isOpen, true);
  document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  assert.equal(menu.isOpen, false);
  assert.equal(panel(menu).hidden, true);
});

test("Escape closes the menu", () => {
  const { menu } = mount();
  btn(menu).click();
  const esc = new global.KeyboardEvent("keydown", { key: "Escape" });
  document.dispatchEvent(esc);
  assert.equal(menu.isOpen, false);
});

test("sync reflects a later visible set onto the boxes", () => {
  const { menu } = mount([]);
  menu.sync(["state"]);
  assert.equal(box(menu, "state").checked, true);
  assert.equal(box(menu, "download").checked, false);
});
