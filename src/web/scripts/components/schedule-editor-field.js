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

// schedule-editor-field.js — the "Schedule" section shared by the tunnel and group
// editors (Feature 150). Two independent, ANDable conditions the user opts into:
//   • a time window — days-of-week + a start/end local wall-clock time;
//   • a network trigger — an SSID allow-list (with a "use current network" helper)
//     and/or a reachability host:port.
// Enabling either condition makes the record scheduled; both off ⇒ no schedule.
// The sub-fields carry the same `data-error-key` paths the validators emit
// (`schedule.time.days`, `schedule.network.reach.port`, …), so the editors' shared
// applyFieldErrors lights them up with no extra plumbing.

import { el, clear } from "../dom.js";
import { field } from "../field.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";

// Day columns in display order: Sunday … Saturday, matching Date.getDay() indices.
const DAY_INDICES = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_DAYS = [1, 2, 3, 4, 5]; // weekdays — the sensible first pick
const DEFAULT_START = "09:00";
const DEFAULT_END = "17:00";

const isWeekday = (v) => Number.isInteger(v) && v >= 0 && v <= 6;
const str = (v) => (typeof v === "string" ? v : "");

export class ScheduleEditorField {
  #porthippo;
  #onChange;
  #heading;

  #el;
  #timeCheck;
  #timeBody;
  #dayButtons = new Map(); // day index → <button>
  #startInput;
  #endInput;
  #netCheck;
  #netBody;
  #ssidListEl;
  #ssidInput;
  #ssidHintEl;
  #reachHostInput;
  #reachPortInput;

  #timeEnabled = false;
  #days = new Set(DEFAULT_DAYS);
  #netEnabled = false;
  #ssids = [];

  /**
   * @param {object} [opts]
   * @param {object} [opts.porthippo]  IPC bridge (for the "use current network" helper)
   * @param {() => void} [opts.onChange]  fired on any edit (live revalidation)
   * @param {boolean} [opts.heading]  show the "Schedule" heading (default true);
   *        the tunnel editor omits it since a "Schedule" tab already labels it.
   */
  constructor({ porthippo, onChange, heading = true } = {}) {
    this.#porthippo =
      porthippo ||
      (typeof window !== "undefined" ? window.porthippo : undefined);
    this.#onChange = onChange || (() => {});
    this.#heading = heading;
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  // ── Value ─────────────────────────────────────────────────────────────────────

  /** Load a stored schedule (or null/undefined for "not scheduled"). */
  setValue(schedule) {
    const s = schedule && typeof schedule === "object" ? schedule : {};
    const time = s.time && typeof s.time === "object" ? s.time : null;
    this.#timeEnabled = Boolean(time);
    this.#days = new Set(
      time && Array.isArray(time.days) && time.days.some(isWeekday)
        ? time.days.filter(isWeekday)
        : DEFAULT_DAYS,
    );
    this.#startInput.value =
      time && str(time.start) ? time.start : DEFAULT_START;
    this.#endInput.value = time && str(time.end) ? time.end : DEFAULT_END;

    const network =
      s.network && typeof s.network === "object" ? s.network : null;
    this.#netEnabled = Boolean(network);
    this.#ssids =
      network && Array.isArray(network.ssids)
        ? network.ssids.filter((x) => typeof x === "string" && x)
        : [];
    const reach = network && network.reach ? network.reach : null;
    this.#reachHostInput.value = reach && str(reach.host) ? reach.host : "";
    this.#reachPortInput.value =
      reach && reach.port != null ? String(reach.port) : "";

    this.#timeCheck.checked = this.#timeEnabled;
    this.#netCheck.checked = this.#netEnabled;
    this.#sync();
  }

  /** The schedule the user configured, or undefined when neither condition is on. */
  get value() {
    const schedule = {};
    if (this.#timeEnabled) {
      schedule.time = {
        days: [...this.#days].sort((a, b) => a - b),
        start: this.#startInput.value,
        end: this.#endInput.value,
      };
    }
    if (this.#netEnabled) {
      const network = {};
      if (this.#ssids.length) network.ssids = [...this.#ssids];
      const host = this.#reachHostInput.value.trim();
      if (host) {
        const port = parseInt(this.#reachPortInput.value, 10);
        network.reach = {
          host,
          port: Number.isFinite(port) ? port : undefined,
        };
      }
      if (Object.keys(network).length) schedule.network = network;
    }
    if (!schedule.time && !schedule.network) return undefined;
    return schedule;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────

  #build() {
    this.#timeCheck = el("input", {
      type: "checkbox",
      class: "schedule-cond-check",
      onChange: (e) => {
        this.#timeEnabled = e.target.checked;
        this.#sync();
        this.#onChange();
      },
    });
    this.#timeBody = this.#buildTimeBody();

    this.#netCheck = el("input", {
      type: "checkbox",
      class: "schedule-cond-check",
      onChange: (e) => {
        this.#netEnabled = e.target.checked;
        this.#sync();
        this.#onChange();
      },
    });
    this.#netBody = this.#buildNetworkBody();

    return el("div", { class: "editor-block schedule-editor" }, [
      ...(this.#heading
        ? [el("span", { class: "field-label", text: t("schedule.section") })]
        : []),
      el("p", { class: "field-hint", text: t("schedule.section.hint") }),
      this.#condition(
        this.#timeCheck,
        t("schedule.time.enable"),
        this.#timeBody,
      ),
      this.#condition(
        this.#netCheck,
        t("schedule.network.enable"),
        this.#netBody,
      ),
    ]);
  }

  /** One condition: its enable checkbox + the (revealed) detail body. */
  #condition(check, label, body) {
    return el("div", { class: "schedule-cond" }, [
      el("label", { class: "editor-check schedule-cond-label" }, [
        check,
        el("span", { class: "editor-check-label", text: label }),
      ]),
      body,
    ]);
  }

  #buildTimeBody() {
    const days = el(
      "div",
      {
        class: "schedule-days",
        role: "group",
        "aria-label": t("schedule.time.days"),
      },
      DAY_INDICES.map((d) => {
        const btn = el("button", {
          type: "button",
          class: "schedule-day-btn",
          text: t(`schedule.day.short.${d}`),
          title: t(`schedule.day.${d}`),
          "aria-pressed": "false",
          onClick: () => this.#toggleDay(d),
        });
        this.#dayButtons.set(d, btn);
        return btn;
      }),
    );

    this.#startInput = el("input", {
      type: "time",
      class: "dialog-input schedule-time-input",
      value: DEFAULT_START,
      onInput: () => this.#onChange(),
    });
    this.#endInput = el("input", {
      type: "time",
      class: "dialog-input schedule-time-input",
      value: DEFAULT_END,
      onInput: () => this.#onChange(),
    });

    return el("div", { class: "schedule-cond-body", hidden: true }, [
      field({
        label: t("schedule.time.days"),
        control: days,
        errorKey: "schedule.time.days",
      }),
      el("div", { class: "schedule-times" }, [
        field({
          label: t("schedule.time.start"),
          control: this.#startInput,
          errorKey: "schedule.time.start",
        }),
        field({
          label: t("schedule.time.end"),
          control: this.#endInput,
          errorKey: "schedule.time.end",
        }),
      ]),
    ]);
  }

  #buildNetworkBody() {
    this.#ssidListEl = el("div", { class: "schedule-ssids" });
    this.#ssidInput = el("input", {
      type: "text",
      class: "dialog-input schedule-ssid-input",
      placeholder: t("schedule.network.ssid.placeholder"),
      onKeydown: (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.#addSsidFromInput();
        }
      },
    });
    const addBtn = el("button", {
      type: "button",
      class: "btn btn--secondary schedule-ssid-add",
      text: t("schedule.network.ssid.add"),
      onClick: () => this.#addSsidFromInput(),
    });
    const currentBtn = el("button", {
      type: "button",
      class: "btn btn--ghost schedule-ssid-current",
      text: t("schedule.network.ssid.useCurrent"),
      onClick: () => this.#useCurrentNetwork(),
    });
    this.#ssidHintEl = el("p", {
      class: "field-hint schedule-ssid-note",
      hidden: true,
    });

    this.#reachHostInput = el("input", {
      type: "text",
      class: "dialog-input schedule-reach-host",
      placeholder: t("schedule.network.reach.hostPlaceholder"),
      onInput: () => this.#onChange(),
    });
    this.#reachPortInput = el("input", {
      type: "number",
      min: "1",
      max: "65535",
      class: "dialog-input schedule-reach-port",
      placeholder: t("schedule.network.reach.portPlaceholder"),
      onInput: () => this.#onChange(),
    });

    return el("div", { class: "schedule-cond-body", hidden: true }, [
      field({
        label: t("schedule.network.ssids"),
        control: el("div", { class: "schedule-ssid-builder" }, [
          this.#ssidListEl,
          el("div", { class: "schedule-ssid-row" }, [
            this.#ssidInput,
            addBtn,
            currentBtn,
          ]),
          this.#ssidHintEl,
        ]),
        errorKey: "schedule.network.ssids",
        hint: t("schedule.network.ssids.hint"),
      }),
      el("div", { class: "schedule-reach" }, [
        field({
          label: t("schedule.network.reach.host"),
          control: this.#reachHostInput,
          errorKey: "schedule.network.reach.host",
          hint: t("schedule.network.reach.hint"),
        }),
        field({
          label: t("schedule.network.reach.port"),
          control: this.#reachPortInput,
          errorKey: "schedule.network.reach.port",
        }),
      ]),
    ]);
  }

  // ── State → DOM ─────────────────────────────────────────────────────────────

  #sync() {
    this.#timeCheck.checked = this.#timeEnabled;
    this.#netCheck.checked = this.#netEnabled;
    this.#timeBody.hidden = !this.#timeEnabled;
    this.#netBody.hidden = !this.#netEnabled;
    for (const [d, btn] of this.#dayButtons) {
      const on = this.#days.has(d);
      btn.classList.toggle("schedule-day-btn--on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    this.#renderSsids();
  }

  #toggleDay(d) {
    if (this.#days.has(d)) this.#days.delete(d);
    else this.#days.add(d);
    this.#sync();
    this.#onChange();
  }

  #renderSsids() {
    clear(this.#ssidListEl);
    if (!this.#ssids.length) {
      this.#ssidListEl.append(
        el("span", {
          class: "schedule-ssids-empty field-hint",
          text: t("schedule.network.ssids.empty"),
        }),
      );
      return;
    }
    for (const ssid of this.#ssids) {
      this.#ssidListEl.append(
        el("span", { class: "schedule-ssid-chip" }, [
          el("span", { class: "schedule-ssid-chip-text", text: ssid }),
          el("button", {
            type: "button",
            class: "schedule-ssid-chip-remove",
            title: t("schedule.network.ssid.remove"),
            "aria-label": t("schedule.network.ssid.remove"),
            html: icons.add(), // rotated to an × via CSS
            onClick: () => this.#removeSsid(ssid),
          }),
        ]),
      );
    }
  }

  #addSsid(name) {
    const ssid = str(name).trim();
    if (!ssid || this.#ssids.includes(ssid)) return;
    this.#ssids.push(ssid);
    this.#renderSsids();
    this.#onChange();
  }

  #addSsidFromInput() {
    this.#addSsid(this.#ssidInput.value);
    this.#ssidInput.value = "";
    this.#ssidInput.focus();
  }

  #removeSsid(name) {
    this.#ssids = this.#ssids.filter((s) => s !== name);
    this.#renderSsids();
    this.#onChange();
  }

  /** Read the current Wi-Fi SSID from main and add it to the allow-list. */
  async #useCurrentNetwork() {
    this.#setSsidNote("");
    let res;
    try {
      res = await this.#porthippo?.schedule?.currentNetwork?.();
    } catch {
      res = null;
    }
    if (res && typeof res.ssid === "string" && res.ssid) {
      this.#addSsid(res.ssid);
    } else {
      this.#setSsidNote(t("schedule.network.ssid.unknown"));
    }
  }

  #setSsidNote(message) {
    this.#ssidHintEl.textContent = message;
    this.#ssidHintEl.hidden = message === "";
  }
}
