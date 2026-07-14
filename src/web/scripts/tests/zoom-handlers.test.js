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

// tests/zoom-handlers.test.js — the UI zoom ("font size") input handlers. A fresh
// jsdom window per test gives each install its own listeners; a mock context
// records the sizes the handlers commit. FONT_SIZES = [11,12,13,14,16,18].

import { resetDom } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { installZoomHandlers } from "../zoom-handlers.js";

function setup({ fontSize = 13 } = {}) {
  resetDom();
  let current = fontSize;
  const applied = [];
  installZoomHandlers({
    getFontSize: () => current,
    setFontSize: (size) => {
      current = size;
      applied.push(size);
    },
  });
  return { current: () => current, applied };
}

function wheel({ ctrlKey = false, deltaY = 0 } = {}) {
  const ev = new window.Event("wheel", { cancelable: true });
  Object.defineProperty(ev, "ctrlKey", { value: ctrlKey });
  Object.defineProperty(ev, "deltaY", { value: deltaY });
  window.dispatchEvent(ev);
}

function keydown(key, mods = {}) {
  window.dispatchEvent(
    new window.KeyboardEvent("keydown", { key, cancelable: true, ...mods }),
  );
}

test("Ctrl+wheel up steps to the next larger size", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: true, deltaY: -1 });
  assert.equal(h.current(), 14);
  assert.deepEqual(h.applied, [14]);
});

test("Ctrl+wheel down steps to the next smaller size", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: true, deltaY: 1 });
  assert.equal(h.current(), 12);
});

test("a plain wheel (no modifier) is ignored", () => {
  const h = setup({ fontSize: 13 });
  wheel({ ctrlKey: false, deltaY: -1 });
  assert.equal(h.current(), 13);
  assert.deepEqual(h.applied, []);
});

test("Ctrl+'+' zooms in and Ctrl+'-' zooms out", () => {
  const h = setup({ fontSize: 13 });
  keydown("+", { ctrlKey: true });
  assert.equal(h.current(), 14);
  keydown("-", { ctrlKey: true });
  assert.equal(h.current(), 13);
});

test("Cmd+'=' also zooms in (unshifted plus)", () => {
  const h = setup({ fontSize: 13 });
  keydown("=", { metaKey: true });
  assert.equal(h.current(), 14);
});

test("Ctrl+'0' resets to the default size", () => {
  const h = setup({ fontSize: 18 });
  keydown("0", { ctrlKey: true });
  assert.equal(h.current(), 13);
});

test("stepping past the max boundary is a no-op", () => {
  const h = setup({ fontSize: 18 }); // already the largest
  wheel({ ctrlKey: true, deltaY: -1 });
  assert.equal(h.current(), 18);
  assert.deepEqual(h.applied, []);
});

test("stepping past the min boundary is a no-op", () => {
  const h = setup({ fontSize: 11 }); // already the smallest
  keydown("-", { ctrlKey: true });
  assert.equal(h.current(), 11);
  assert.deepEqual(h.applied, []);
});

test("an off-list size snaps to the nearest entry before stepping", () => {
  const h = setup({ fontSize: 15 }); // not in the list; nearest is 14 or 16
  keydown("+", { ctrlKey: true });
  assert.equal(h.current(), 16);
});

test("a ⌥-modified combo is left alone", () => {
  const h = setup({ fontSize: 13 });
  keydown("0", { metaKey: true, altKey: true });
  assert.equal(h.current(), 13);
});

test("the zoom keys pass through inside a text field", () => {
  const h = setup({ fontSize: 13 });
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.dispatchEvent(
    new window.KeyboardEvent("keydown", {
      key: "+",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  assert.equal(h.current(), 13);
});

test("porthippo:ui-font-change menu events step / reset the size", () => {
  const h = setup({ fontSize: 13 });
  window.dispatchEvent(
    new window.CustomEvent("porthippo:ui-font-change", { detail: "in" }),
  );
  assert.equal(h.current(), 14);
  window.dispatchEvent(
    new window.CustomEvent("porthippo:ui-font-change", { detail: "reset" }),
  );
  assert.equal(h.current(), 13);
});
