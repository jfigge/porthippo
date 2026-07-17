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

// group-editor-dialog.js — create/edit a reusable tunnel group (Feature 140) in a
// native <dialog>. A group is purely organisational: a label plus a colour picked
// from the fixed GROUP_COLORS token palette (never a free hex). On a successful
// store write it emits a global `porthippo:groups-changed` so open lists / the tray
// refresh, and calls back `onSaved(record)` for the opener that launched it.

import { el } from "../dom.js";
import { field, applyFieldErrors } from "../field.js";
import { t } from "../i18n.js";
import { Dialog } from "../dialog.js";
import { ScheduleEditorField } from "./schedule-editor-field.js";
import {
  GROUP_COLORS,
  DEFAULT_GROUP_COLOR,
  validateGroup,
} from "../validate.js";

export class GroupEditorDialog {
  #dialog;
  #porthippo;
  #onSaved;

  #form = blankForm();
  #editingId = null;

  #labelInput;
  #swatchesEl;
  #swatchButtons = new Map(); // color key → its <button>
  #scheduleField; // Feature 150 — the group's schedule (inherited by its members)

  /**
   * @param {object} [opts]
   * @param {object} [opts.porthippo]  IPC bridge (defaults to window.porthippo)
   * @param {(record: object) => void} [opts.onSaved]  the created/updated record
   */
  constructor({ porthippo, onSaved } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#onSaved = onSaved;

    this.#scheduleField = new ScheduleEditorField({
      porthippo: this.#porthippo,
      onChange: () => this.#dialog.clearError(),
    });

    this.#dialog = new Dialog({
      className: "group-dialog",
      title: t("group.newTitle"),
      onSubmit: () => this.#save(),
      onCancel: () => this.#dialog.close(),
    });
    this.#buildBody();
  }

  get element() {
    return this.#dialog.element;
  }

  /** Open a blank editor for a new group. */
  openCreate() {
    this.#load(null);
    this.#dialog.setTitle(t("group.newTitle"));
    this.#dialog.open();
  }

  /** Open the editor prefilled from an existing group. */
  openEdit(group) {
    this.#load(group);
    this.#dialog.setTitle(t("group.editTitle"));
    this.#dialog.open();
  }

  // ── Form state ──────────────────────────────────────────────────────────────

  #load(group) {
    const g = group && typeof group === "object" ? group : {};
    this.#editingId = g.id || null;
    this.#form = {
      label: str(g.label),
      color: GROUP_COLORS.includes(g.color) ? g.color : DEFAULT_GROUP_COLOR,
    };
    this.#labelInput.value = this.#form.label;
    this.#scheduleField.setValue(g.schedule);
    this.#syncSwatches();
    applyFieldErrors(this.#dialog.body, {});
    this.#dialog.clearError();
  }

  buildPayload() {
    const payload = { label: this.#form.label.trim(), color: this.#form.color };
    // Feature 150 — the group's schedule, inherited by members without their own.
    const schedule = this.#scheduleField.value;
    if (schedule) payload.schedule = schedule;
    return payload;
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  #buildBody() {
    this.#labelInput = el("input", {
      class: "dialog-input group-label-input",
      type: "text",
      placeholder: t("group.label.placeholder"),
      "aria-label": t("group.label"),
      "data-autofocus": true,
      onInput: (e) => (this.#form.label = e.target.value),
    });

    this.#swatchesEl = el("div", {
      class: "group-swatches",
      role: "radiogroup",
      "aria-label": t("group.color"),
    });
    for (const color of GROUP_COLORS) {
      const btn = el("button", {
        class: `group-swatch group-swatch--${color}`,
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "aria-label": t(`group.color.${color}`),
        title: t(`group.color.${color}`),
        onClick: () => this.#selectColor(color),
      });
      this.#swatchButtons.set(color, btn);
      this.#swatchesEl.append(btn);
    }

    this.#dialog.body.append(
      field({
        label: t("group.label"),
        control: this.#labelInput,
        errorKey: "label",
      }),
      field({
        label: t("group.color"),
        control: this.#swatchesEl,
        errorKey: "color",
      }),
      this.#scheduleField.element,
    );
    this.#syncSwatches();
  }

  #selectColor(color) {
    if (!GROUP_COLORS.includes(color)) return;
    this.#form.color = color;
    this.#syncSwatches();
  }

  /** Reflect the selected colour onto the swatch buttons. */
  #syncSwatches() {
    for (const [color, btn] of this.#swatchButtons) {
      const selected = color === this.#form.color;
      btn.classList.toggle("group-swatch--selected", selected);
      btn.setAttribute("aria-checked", selected ? "true" : "false");
    }
  }

  // ── Save ────────────────────────────────────────────────────────────────────

  async #save() {
    const payload = this.buildPayload();
    const { valid, errors } = validateGroup(payload);
    applyFieldErrors(this.#dialog.body, errors);
    if (!valid) return;

    let result;
    try {
      result = this.#editingId
        ? await this.#porthippo.groups.update(this.#editingId, payload)
        : await this.#porthippo.groups.create(payload);
    } catch (err) {
      this.#dialog.showError(
        t("editor.saveError", { message: err?.message || String(err) }),
      );
      return;
    }

    if (result && result.__hippoError) {
      if (result.errors) applyFieldErrors(this.#dialog.body, result.errors);
      this.#dialog.showError(
        t("editor.saveError", { message: result.message || result.code || "" }),
      );
      return;
    }

    this.#dialog.close();
    window.dispatchEvent(
      new CustomEvent("porthippo:groups-changed", {
        detail: { id: result && result.id },
      }),
    );
    this.#onSaved?.(result);
  }
}

// ── Blank-state helpers ───────────────────────────────────────────────────────

function str(v) {
  return typeof v === "string" ? v : "";
}
function blankForm() {
  return { label: "", color: DEFAULT_GROUP_COLOR };
}
