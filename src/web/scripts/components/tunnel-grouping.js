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

// tunnel-grouping.js — the pure grouping model shared by BOTH list views
// (tunnel-list.js cards + tunnel-table.js list) and their owner (tunnels-view.js),
// so the two-level tree, its order, and the state rollups can never drift between
// the views. No DOM, no IPC — just the transforms.
//
// Feature 140: a tunnel belongs to zero or one group (`groupId`). Groups render as
// collapsible sections ordered by group order; ungrouped tunnels fall into an
// implicit "Ungrouped" section shown last. When there are NO groups at all,
// `buildSections` returns null so a view renders its plain flat list unchanged.

import { GROUP_COLORS } from "../validate.js";

/** The synthetic id of the implicit "Ungrouped" section. */
export const UNGROUPED_ID = "__ungrouped";

/** Armed = the engine holds this tunnel (anything but disarmed / error). */
export function isArmedState(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

/** A group's colour token key, defaulting to the first palette entry if unknown. */
export function groupColorKey(group) {
  const c = group && group.color;
  return GROUP_COLORS.includes(c) ? c : GROUP_COLORS[0];
}

/**
 * Split `defs` into ordered sections by group. Returns null when there are no
 * groups (the caller renders a flat list). Every group gets a section (even an
 * empty one, so it stays a visible drop target); ungrouped tunnels — including any
 * whose `groupId` no longer resolves — collect into a trailing "Ungrouped" section
 * shown only when non-empty.
 *
 * @param {object[]} defs   tunnel rows (each may carry an optional `groupId`)
 * @param {object[]} groups ordered group records (`{ id, label, color }`)
 * @param {Set<string>|string[]} [collapsedIds]  ids of collapsed sections
 * @returns {null | Array<{id, group, defs, collapsed}>}
 */
export function buildSections(defs, groups, collapsedIds) {
  const list = Array.isArray(groups) ? groups : [];
  if (list.length === 0) return null;

  const collapsed =
    collapsedIds instanceof Set
      ? collapsedIds
      : new Set(Array.isArray(collapsedIds) ? collapsedIds : []);
  const known = new Set(list.map((g) => g.id));
  const byGroup = new Map();
  const ungrouped = [];

  for (const def of Array.isArray(defs) ? defs : []) {
    const gid = def && def.groupId;
    if (gid && known.has(gid)) {
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid).push(def);
    } else {
      ungrouped.push(def);
    }
  }

  const sections = list.map((g) => ({
    id: g.id,
    group: g,
    defs: byGroup.get(g.id) || [],
    collapsed: collapsed.has(g.id),
  }));
  if (ungrouped.length > 0) {
    sections.push({
      id: UNGROUPED_ID,
      group: null,
      defs: ungrouped,
      collapsed: collapsed.has(UNGROUPED_ID),
    });
  }
  return sections;
}

/** Armed / total rollup for a section's tunnels. */
export function sectionRollup(defs, states) {
  const get = states instanceof Map ? (id) => states.get(id) : () => undefined;
  let armed = 0;
  for (const d of defs) if (isArmedState(get(d.id))) armed++;
  return { armed, total: defs.length };
}

/**
 * Pause/resume rollup for a section: how many of its tunnels are `paused` vs
 * actively `connected`. Used to drive the group header's pause/resume icon —
 * only these two states are pausable/resumable, so both being 0 means the
 * control has nothing to act on.
 */
export function sectionPauseRollup(defs, states) {
  const get = states instanceof Map ? (id) => states.get(id) : () => undefined;
  let paused = 0;
  let connected = 0;
  for (const d of defs) {
    const s = get(d.id);
    if (s === "paused") paused++;
    else if (s === "connected") connected++;
  }
  return { paused, connected };
}

/**
 * The pause/resume decision for a section from its {@link sectionPauseRollup}:
 * `action` is what a click should do, `resume` whether to show the resume (play)
 * glyph, and `enabled` whether anything is pausable/resumable at all. We only
 * flip to *resume* once every still-active tunnel is paused, mirroring the
 * arm-switch's "all → inverse" rule.
 */
export function sectionPauseState({ paused, connected }) {
  const resume = connected === 0 && paused > 0;
  return {
    action: resume ? "resume" : "pause",
    resume,
    enabled: paused + connected > 0,
  };
}

/** Summed up/down byte rates for a section's tunnels (Monitoring traffic rollup). */
export function sectionThroughput(defs, snaps) {
  const get = snaps instanceof Map ? (id) => snaps.get(id) : () => null;
  let up = 0;
  let down = 0;
  for (const d of defs) {
    const snap = get(d.id);
    if (!snap) continue;
    up += Number(snap.rateUp) || 0;
    down += Number(snap.rateDown) || 0;
  }
  return { up, down };
}
