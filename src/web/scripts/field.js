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

// field.js — form-field construction + centralized inline-error application.
//
// `field({...})` wraps a control in a `.field` that carries `data-error-key` — a
// dotted validation path like "destination.host" or "credentialId". The editors
// build their controls with the matching key and call `applyFieldErrors(root,
// errors)`, which routes each keyed message to its field with no per-editor error
// plumbing.

import { el } from "./dom.js";

/**
 * Build a labeled field: optional label, the control, optional hint, and an
 * (initially hidden) error slot, all under a `.field` wrapper tagged with
 * `data-error-key` when one is given.
 *
 * @param {object} opts
 * @param {string} [opts.label]
 * @param {HTMLElement} opts.control
 * @param {string} [opts.errorKey]  dotted validation path this field owns
 * @param {string} [opts.hint]
 * @param {string} [opts.description]  long-form help shown as a native tooltip on
 *        the label (and mirrored to the control's title), for fields whose rules
 *        don't fit in a one-line hint.
 * @param {string} [opts.labelFor]  id to associate the label with
 * @param {string} [opts.className] extra class on the wrapper
 * @returns {HTMLElement}
 */
export function field({
  label,
  control,
  errorKey,
  hint,
  description,
  labelFor,
  className,
} = {}) {
  const children = [];
  if (label) {
    const labelAttrs = { class: "field-label", for: labelFor, text: label };
    // A description surfaces as a hover tooltip on the label and, so it's
    // discoverable from the input too, on the control itself.
    if (description) {
      labelAttrs.title = description;
      labelAttrs.class = "field-label field-label--described";
      if (control && !control.title) control.title = description;
    }
    children.push(el("label", labelAttrs));
  }
  children.push(control);
  if (hint) children.push(el("p", { class: "field-hint", text: hint }));
  children.push(el("p", { class: "field-error", hidden: true, role: "alert" }));

  return el(
    "div",
    {
      class: className ? `field ${className}` : "field",
      dataset: errorKey ? { errorKey } : {},
    },
    children,
  );
}

/**
 * Clear every field's error under `root`, then route each `errors` entry (keyed
 * by dotted path) to the field whose `data-error-key` matches. Fields whose key
 * has no error are left clean. Returns the number of messages placed.
 *
 * @param {HTMLElement} root
 * @param {Object<string,string>} [errors]
 * @returns {number}
 */
export function applyFieldErrors(root, errors = {}) {
  for (const f of root.querySelectorAll(".field")) {
    const slot = f.querySelector(":scope > .field-error");
    if (slot) {
      slot.textContent = "";
      slot.hidden = true;
    }
    f.classList.remove("field--error");
  }

  let applied = 0;
  for (const [key, message] of Object.entries(errors)) {
    // Attribute-selector values are quoted, so dots/brackets in the path are
    // literal; only a stray double-quote would need escaping (paths never carry
    // one). Guard defensively anyway.
    const f = root.querySelector(
      `.field[data-error-key="${key.replace(/"/g, '\\"')}"]`,
    );
    if (!f) continue;
    const slot = f.querySelector(":scope > .field-error");
    if (slot) {
      slot.textContent = message;
      slot.hidden = false;
    }
    f.classList.add("field--error");
    applied++;
  }
  return applied;
}
