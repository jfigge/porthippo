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
 * Build a labeled field: optional label, the control, and an (initially hidden)
 * error slot, all under a `.field` wrapper tagged with `data-error-key` when one
 * is given.
 *
 * Help text (the concise `hint` and the long-form `description`, combined) is not
 * shown inline — it's surfaced through an (i) info icon beside the label and
 * mirrored onto the control's own tooltip. A field with help but no label (nothing
 * to anchor the icon to) falls back to a visible `.field-hint` line.
 *
 * @param {object} opts
 * @param {string} [opts.label]
 * @param {HTMLElement} opts.control
 * @param {string} [opts.errorKey]  dotted validation path this field owns
 * @param {string} [opts.hint]  concise one-line help
 * @param {string} [opts.description]  long-form help, for rules that don't fit in
 *        a one-line hint
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
  const help = [hint, description].filter(Boolean).join("\n\n");
  if (label) {
    const labelEl = el("label", {
      class: "field-label",
      for: labelFor,
      text: label,
    });
    if (help) {
      // The help lives on an (i) icon by the label; mirror it onto the control so
      // it's discoverable from the input too.
      children.push(
        el("span", { class: "field-label-row" }, [labelEl, infoIcon(help)]),
      );
      if (control && !control.title) control.title = help;
    } else {
      children.push(labelEl);
    }
  } else if (help) {
    // No label to hang the icon on — keep the help visible as a hint line.
    children.push(el("p", { class: "field-hint", text: help }));
  }
  children.push(control);
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

/** An (i) info marker whose help text lives in its native tooltip. */
function infoIcon(text) {
  return el("span", {
    class: "field-info",
    role: "img",
    title: text,
    "aria-label": text,
    text: "i",
  });
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
