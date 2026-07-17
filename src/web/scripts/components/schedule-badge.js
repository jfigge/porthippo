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

// schedule-badge.js — the shared "this tunnel is on a schedule" row adornment
// (Feature 150). A small clock glyph with the next time-window transition ("9:00")
// beside it and the full phrase as its tooltip, or a distinct "hand" tint while
// the user has overridden the rule. The same helper is used by the card sidebar,
// the detail breadcrumb, and the list table so the three presentations can't drift
// (card ↔ list parity). It reads the shared scheduleStore, so a row only carries an
// empty holder span and asks this module to (re)fill it.

import { el, clear } from "../dom.js";
import { t, formatDate } from "../i18n.js";
import { icons } from "../icons.js";
import { scheduleStore } from "../schedule-store.js";

const TIME_OPTS = { hour: "numeric", minute: "2-digit" };

/**
 * Derive the badge's short label + full tooltip for a schedule status entry, or
 * null when the tunnel isn't governed (nothing to badge). Pure — unit-testable
 * without the DOM.
 *
 * @param {object|null} entry  a `porthippo:schedule` tunnel entry
 * @returns {{ label: string, title: string, overridden: boolean }|null}
 */
export function scheduleBadgeInfo(entry) {
  if (!entry) return null;
  const when =
    entry.nextTransitionAt != null
      ? formatDate(entry.nextTransitionAt, TIME_OPTS)
      : "";

  if (entry.overridden) {
    return {
      overridden: true,
      label: "",
      title: when
        ? t("schedule.badge.overriddenUntil", { time: when })
        : t("schedule.badge.overridden"),
    };
  }
  if (entry.nextTransitionKind === "arm" && when) {
    return {
      overridden: false,
      label: when,
      title: t("schedule.badge.armsAt", { time: when }),
    };
  }
  if (entry.nextTransitionKind === "disarm" && when) {
    return {
      overridden: false,
      label: when,
      title: t("schedule.badge.disarmsAt", { time: when }),
    };
  }
  // A network-only rule has no predictable next edge.
  return { overridden: false, label: "", title: t("schedule.badge.managed") };
}

/**
 * (Re)fill a holder span with the schedule badge for `id`, reading the live
 * scheduleStore. Empties the span (and hides it) when the tunnel isn't governed.
 *
 * @param {HTMLElement} span
 * @param {string} id  tunnel id
 */
export function renderScheduleBadge(span, id) {
  if (!span) return;
  clear(span);
  const info = scheduleBadgeInfo(scheduleStore.get(id));
  if (!info) {
    span.hidden = true;
    span.className = "tunnel-schedule-badge";
    span.removeAttribute("title");
    span.removeAttribute("aria-label");
    return;
  }
  span.hidden = false;
  span.className = `tunnel-schedule-badge${info.overridden ? " tunnel-schedule-badge--overridden" : ""}`;
  span.title = info.title;
  span.setAttribute("aria-label", info.title);
  span.insertAdjacentHTML("beforeend", icons.clock());
  if (info.label) {
    span.appendChild(
      el("span", { class: "tunnel-schedule-badge-text", text: info.label }),
    );
  }
}

/** Build a fresh badge holder for a row's identity, filled from the store. */
export function newScheduleBadge(id) {
  const span = el("span", { class: "tunnel-schedule-badge", role: "img" });
  renderScheduleBadge(span, id);
  return span;
}
