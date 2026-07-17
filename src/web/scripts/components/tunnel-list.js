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

// tunnel-list.js — the master sidebar: a list of tunnels, one row each with a
// status signal, the type icon, and the name. An Add icon sits in the header; edit,
// delete and the other row actions all live on the row's right-click context menu,
// owned by TunnelsView. Selection, add and context-menu requests are reported to
// the owning TunnelsView via constructor callbacks; the list itself holds no IPC
// and computes nothing — state is fed in.
//
// Feature 140: when groups exist the flat list becomes a two-level tree of
// collapsible group sections (each with an arm-all switch + rollup) followed by an
// implicit "Ungrouped" section, and group headers drag-reorder. Dragging a tunnel
// shows a live "blank entry" gap at the drop position: dropping it both moves the
// tunnel into that group AND sequences it there (dropping off any group cancels).
// The grouping model itself is the shared, DOM-free tunnel-grouping.js so the cards
// + list views can't drift.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { newScheduleBadge, renderScheduleBadge } from "./schedule-badge.js";
import {
  buildSections,
  sectionRollup,
  sectionPauseRollup,
  sectionPauseState,
  groupColorKey,
  UNGROUPED_ID,
} from "./tunnel-grouping.js";

/**
 * The status-dot bucket for a live state: grey `disarmed`, green `armed`
 * (listening / connecting / connected), yellow `paused`, red `error`.
 * Still used by the Monitoring table (`tunnel-table.js`).
 * @param {string} state
 * @returns {"disarmed"|"armed"|"paused"|"error"}
 */
export function dotState(state) {
  if (state === "paused") return "paused";
  if (state === "error") return "error";
  if (state && state !== "disarmed") return "armed";
  return "disarmed";
}

/**
 * Which traffic-light lamp is lit for a live state (sidebar signal): `red`
 * (error), `amber` (armed but not connected — listening / connecting / paused),
 * `green` (connected), or `off` (disarmed — no lamp lit). Position, not colour
 * alone, carries the meaning.
 * @param {string} state
 * @returns {"red"|"amber"|"green"|"off"}
 */
export function signalLamp(state) {
  if (state === "connected") return "green";
  if (state === "error") return "red";
  if (!state || state === "disarmed") return "off";
  return "amber"; // listening, connecting, paused
}

/**
 * Build a row's three-lamp status signal: a `.tunnel-signal` container holding a
 * red / amber / green lamp, with a `--red|--amber|--green` modifier lighting the
 * lamp for the active state (or none when disarmed). The localized state is the
 * container tooltip and accessible label; each lamp also carries a static hint
 * describing what lighting it means.
 * @param {string} state
 * @returns {HTMLElement}
 */
export function buildSignal(state) {
  const lamp = signalLamp(state);
  return el(
    "span",
    {
      class: `tunnel-signal${lamp === "off" ? "" : ` tunnel-signal--${lamp}`}`,
      role: "img",
      title: t(`state.${state}`),
      "aria-label": t(`state.${state}`),
    },
    [
      el("span", {
        class: "tunnel-signal-lamp tunnel-signal-lamp--red",
        title: t("state.signal.red"),
      }),
      el("span", {
        class: "tunnel-signal-lamp tunnel-signal-lamp--amber",
        title: t("state.signal.amber"),
      }),
      el("span", {
        class: "tunnel-signal-lamp tunnel-signal-lamp--green",
        title: t("state.signal.green"),
      }),
    ],
  );
}

/**
 * A monochrome forwarding-type glyph for a row (Feature 110 redesign): every type
 * gets a consistent icon — `local`, `remote`, or `dynamic` (SOCKS) — replacing the
 * old text badges so the type reads at a glance and the common case is no longer a
 * blank. The full type name is the tooltip and accessible label.
 * @param {object} def
 * @returns {HTMLElement}
 */
export function typeIcon(def) {
  const type = (def && def.type) || "local";
  const glyph =
    type === "remote"
      ? icons.tunnelRemote
      : type === "dynamic"
        ? icons.tunnelDynamic
        : icons.tunnelLocal;
  const label = t(`editor.type.${type}`);
  return el("span", {
    class: `tunnel-type-icon tunnel-type-icon--${type}`,
    html: glyph(),
    role: "img",
    title: label,
    "aria-label": label,
  });
}

export class TunnelList {
  #el;
  #listEl;
  #emptyEl;
  #defs = [];
  #states = new Map();
  #selectedId = null;
  #rows = new Map(); // id → { root, signal }
  #sections = new Map(); // sectionId → { header, rollupEl, armSwitch, pauseBtn, defs }

  // Grouping (Feature 140): empty groups → flat list, unchanged.
  #groups = [];
  #collapsedIds = new Set();
  #drag = null; // { kind: "tunnel"|"group", id } during a drag
  #dropSectionId = null; // section currently shown as the drop target
  #dropHeaderOnly = false; // true → only the header highlights (group reorder)
  #placeholder = null; // the live "blank entry" gap shown at the drop position
  #insert = null; // { groupId, beforeId } the pending in-group drop, or null

  #onSelect;
  #onAdd;
  #onContextMenu;
  #onToggleCollapse;
  #onGroupAction;
  #onGroupMenu;
  #onMoveTunnel;
  #onReorderGroups;

  constructor({
    onSelect,
    onAdd,
    onContextMenu,
    onToggleCollapse,
    onGroupAction,
    onGroupMenu,
    onMoveTunnel,
    onReorderGroups,
  } = {}) {
    this.#onSelect = onSelect || (() => {});
    this.#onAdd = onAdd || (() => {});
    this.#onContextMenu = onContextMenu || (() => {});
    this.#onToggleCollapse = onToggleCollapse || (() => {});
    this.#onGroupAction = onGroupAction || (() => {});
    this.#onGroupMenu = onGroupMenu || (() => {});
    this.#onMoveTunnel = onMoveTunnel || (() => {});
    this.#onReorderGroups = onReorderGroups || (() => {});
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  #build() {
    // Drag & drop is delegated here so the live drop gap + "cancel off a group"
    // rule live in one place (see #onListDragOver / #onListDrop).
    this.#listEl = el("div", {
      class: "tunnel-list",
      role: "list",
      onDragover: (e) => this.#onListDragOver(e),
      onDrop: (e) => this.#onListDrop(e),
      onDragleave: (e) => this.#onListDragLeave(e),
    });
    this.#emptyEl = el("div", { class: "tunnel-list-empty" }, [
      el("p", { class: "tunnel-list-empty-title", text: t("tunnels.empty") }),
      el("p", {
        class: "tunnel-list-empty-hint",
        text: t("tunnels.emptyHint"),
      }),
    ]);

    const addBtn = el("button", {
      class: "btn--icon tunnel-add-btn",
      type: "button",
      title: t("tunnels.add"),
      "aria-label": t("tunnels.add"),
      html: icons.add(),
      onClick: () => this.#onAdd(),
    });

    return el(
      "aside",
      { class: "tunnel-sidebar", "aria-label": t("tunnels.title") },
      [
        el("div", { class: "tunnel-sidebar-header" }, [
          el("span", {
            class: "tunnel-sidebar-title",
            text: t("tunnels.title"),
          }),
          addBtn,
        ]),
        this.#emptyEl,
        this.#listEl,
      ],
    );
  }

  /** Feed the definition list + a state map, optionally (re)setting the selection. */
  setData(defs, states, selectedId) {
    this.#defs = Array.isArray(defs) ? defs : [];
    this.#states = states instanceof Map ? states : new Map();
    if (selectedId !== undefined) this.#selectedId = selectedId;
    this.#render();
  }

  /**
   * Feed the grouping context (Feature 140): the ordered groups and the collapsed
   * section ids. Empty groups render flat.
   */
  setGrouping({ groups, collapsedIds } = {}) {
    if (groups !== undefined)
      this.#groups = Array.isArray(groups) ? groups : [];
    if (collapsedIds !== undefined) this.#collapsedIds = toSet(collapsedIds);
    this.#render();
  }

  /** Highlight the selected row (no re-render). */
  setSelected(id) {
    this.#selectedId = id;
    for (const [rowId, rec] of this.#rows) {
      const on = rowId === id;
      rec.root.classList.toggle("tunnel-row--selected", on);
      rec.root.setAttribute("aria-selected", String(on));
    }
  }

  /** Update one row's status signal in place from a live-state change. */
  updateState(id, state) {
    this.#states.set(id, state);
    const rec = this.#rows.get(id);
    if (rec) {
      const lamp = signalLamp(state);
      rec.signal.className = `tunnel-signal${lamp === "off" ? "" : ` tunnel-signal--${lamp}`}`;
      rec.signal.title = t(`state.${state}`);
      rec.signal.setAttribute("aria-label", t(`state.${state}`));
    }
    this.#refreshHeaders();
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

  #render() {
    clear(this.#listEl);
    this.#rows.clear();
    this.#sections.clear();
    const empty = this.#defs.length === 0;
    this.#emptyEl.hidden = !empty;
    this.#listEl.hidden = empty;

    const sections = buildSections(
      this.#defs,
      this.#groups,
      this.#collapsedIds,
    );
    if (!sections) {
      // No groups → the flat list, unchanged.
      for (const def of this.#defs) this.#appendRow(def, null);
    } else {
      for (const section of sections) {
        this.#listEl.appendChild(this.#buildGroupHeader(section));
        if (!section.collapsed) {
          for (const def of section.defs) this.#appendRow(def, section);
        }
      }
    }
    this.setSelected(this.#selectedId);
  }

  #appendRow(def, section) {
    const rec = this.#buildRow(def, section);
    this.#rows.set(def.id, rec);
    this.#listEl.appendChild(rec.root);
  }

  #buildRow(def, section) {
    const state = this.#states.get(def.id) || "disarmed";
    const signal = buildSignal(state);
    // Feature 150: a scheduled tunnel is badged with its next transition; the
    // holder is empty (and hidden) when the tunnel isn't governed.
    const sched = newScheduleBadge(def.id);

    // Edit, delete and the other row actions all live on the row's right-click
    // context menu (owned by TunnelsView), so the row carries no inline buttons.
    const root = el(
      "div",
      {
        class: "tunnel-row",
        role: "listitem",
        tabindex: "0",
        draggable: "true",
        // The section id lets a row act as a drop target for its whole group.
        dataset: section ? { id: def.id, section: section.id } : { id: def.id },
        onClick: () => this.#onSelect(def.id),
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.#onSelect(def.id);
          }
        },
        // Secondary (right) click opens the native OS row menu.
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onContextMenu(def.id);
        },
        // Drag a row to reassign + resequence it; dragover/drop is delegated to
        // the list container (#onListDragOver) so the live gap has one owner.
        onDragstart: (e) => this.#onRowDragStart(e, def.id),
        onDragend: () => this.#clearDrag(),
      },
      [
        signal,
        typeIcon(def),
        el("span", {
          class: "tunnel-row-name",
          text: def.name || t("def.unnamed"),
        }),
        sched,
      ],
    );

    return { root, signal, sched, sectionId: section ? section.id : null };
  }

  /** Refresh every row's schedule badge from the store (Feature 150). */
  applySchedule() {
    for (const [id, rec] of this.#rows) renderScheduleBadge(rec.sched, id);
  }

  #buildGroupHeader(section) {
    const group = section.group;
    const rollup = sectionRollup(section.defs, this.#states);
    const name = group ? group.label : t("group.ungrouped");

    const chevron = el("button", {
      // The glyph rotates via CSS on the collapsed header, so one icon serves both.
      class: "group-chevron btn--icon",
      type: "button",
      "aria-label": section.collapsed ? t("group.expand") : t("group.collapse"),
      html: icons.chevronDown(),
      onClick: (e) => {
        e.stopPropagation();
        this.#onToggleCollapse(section.id);
      },
    });

    const swatch = group
      ? el("span", {
          class: `group-swatch group-swatch--${groupColorKey(group)} group-chip`,
          "aria-hidden": "true",
        })
      : el("span", { class: "group-chip group-chip--ungrouped" });

    const nameEl = el("span", { class: "group-name", text: name });
    const rollupEl = el("span", {
      class: "group-count",
      text: t("group.count", { armed: rollup.armed, total: rollup.total }),
    });

    // Arm-all / disarm-all switch (checked = all armed; indeterminate = some).
    const armSwitch = el("input", {
      class: "detail-arm-switch group-arm-switch",
      type: "checkbox",
      role: "switch",
      "aria-label": t("group.armAll"),
      onClick: (e) => e.stopPropagation(),
      onChange: () => {
        // Recompute from live state at click time — the captured `rollup` above
        // is only a snapshot from header-build and goes stale as tunnels change.
        const live = sectionRollup(section.defs, this.#states);
        const all = live.total > 0 && live.armed === live.total;
        this.#onGroupAction(section.id, all ? "disarm" : "arm");
      },
    });
    this.#applyArmSwitch(armSwitch, rollup);

    // Pause-all / resume-all icon (acts on the whole group, ignoring selection).
    const pauseBtn = el("button", {
      class: "group-pause-btn btn--icon",
      type: "button",
      onClick: (e) => {
        e.stopPropagation();
        // Recompute from live state so a stale header snapshot can't misfire.
        const { action, enabled } = sectionPauseState(
          sectionPauseRollup(section.defs, this.#states),
        );
        if (enabled) this.#onGroupAction(section.id, action);
      },
    });
    this.#applyPauseBtn(
      pauseBtn,
      sectionPauseRollup(section.defs, this.#states),
    );

    const header = el(
      "div",
      {
        class: `group-header${section.collapsed ? " group-header--collapsed" : ""}`,
        role: "listitem",
        dataset: { section: section.id },
        "aria-expanded": String(!section.collapsed),
        // A real group is draggable to reorder; both kinds accept a row drop.
        draggable: group ? "true" : null,
        onClick: () => this.#onToggleCollapse(section.id),
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onGroupMenu(section.id);
        },
        onDragstart: group
          ? (e) => this.#onHeaderDragStart(e, group.id)
          : undefined,
        onDragend: () => this.#clearDrag(),
      },
      [chevron, swatch, nameEl, rollupEl, pauseBtn, armSwitch],
    );

    this.#sections.set(section.id, {
      header,
      rollupEl,
      armSwitch,
      pauseBtn,
      defs: section.defs,
    });
    return header;
  }

  /** Recompute every group header's rollup + arm switch in place (no re-render). */
  #refreshHeaders() {
    for (const [, rec] of this.#sections) {
      const rollup = sectionRollup(rec.defs, this.#states);
      rec.rollupEl.textContent = t("group.count", {
        armed: rollup.armed,
        total: rollup.total,
      });
      this.#applyArmSwitch(rec.armSwitch, rollup);
      this.#applyPauseBtn(
        rec.pauseBtn,
        sectionPauseRollup(rec.defs, this.#states),
      );
    }
  }

  #applyArmSwitch(sw, rollup) {
    const all = rollup.total > 0 && rollup.armed === rollup.total;
    sw.checked = all;
    sw.indeterminate = rollup.armed > 0 && !all;
  }

  #applyPauseBtn(btn, pause) {
    const { resume, enabled } = sectionPauseState(pause);
    btn.innerHTML = resume ? icons.play() : icons.pause();
    btn.disabled = !enabled;
    const label = resume ? t("group.resumeAll") : t("group.pauseAll");
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }

  // ── Drag & drop (row → reassign + resequence; group header → reorder) ─────────

  #onRowDragStart(e, id) {
    this.#drag = { kind: "tunnel", id };
    // The row is collapsed only once a drop gap opens (see #setDraggedHidden), not
    // synchronously here — hiding the drag source in dragstart cancels the drag.
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", id);
      } catch {
        // ignore — jsdom / restricted environments
      }
    }
  }

  #onHeaderDragStart(e, groupId) {
    this.#drag = { kind: "group", id: groupId };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", groupId);
      } catch {
        // ignore
      }
    }
    e.currentTarget.classList.add("group-header--dragging");
  }

  // Delegated dragover on the list container: for a tunnel drag it lights the
  // section under the pointer and inserts the blank gap where the drop would land;
  // off any group it clears everything so the drop cancels. For a group drag it
  // highlights only a DIFFERENT real group header (reorder).
  #onListDragOver(e) {
    const drag = this.#drag;
    if (!drag) return;

    if (drag.kind === "group") {
      const headerEl = e.target?.closest?.(".group-header");
      const sectionId = headerEl?.dataset.section;
      if (
        sectionId &&
        sectionId !== drag.id &&
        this.#groups.some((g) => g.id === sectionId)
      ) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        this.#showDrop(sectionId, true);
      } else {
        this.#clearDropHighlight();
      }
      this.#clearPlaceholder();
      return;
    }

    // Tunnel drag. Hovering the gap itself keeps the current target (the gap is a
    // real element, so without this the pointer over it would read as "off group").
    if (
      this.#placeholder &&
      (e.target === this.#placeholder || this.#placeholder.contains(e.target))
    ) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      return;
    }
    const rowEl = e.target?.closest?.(".tunnel-row");
    const headerEl = e.target?.closest?.(".group-header");
    if (rowEl && rowEl.dataset.section != null) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.#showDrop(rowEl.dataset.section, false);
      this.#gapAtRow(rowEl, e.clientY);
    } else if (headerEl) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.#showDrop(headerEl.dataset.section, false);
      this.#gapAtHeader(headerEl);
    } else if (this.#pointerWithinDropSection(e.clientY)) {
      // Between rows of the active section (over the gap band) — keep it.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    } else {
      // Off any group → cancel: no highlight, no gap, and (no preventDefault) the
      // browser refuses the drop here.
      this.#clearDropHighlight();
      this.#clearPlaceholder();
    }
  }

  #onListDrop(e) {
    const drag = this.#drag;
    const insert = this.#insert;
    const headerOnly = this.#dropHeaderOnly;
    const dropSection = this.#dropSectionId;
    this.#clearDrag();
    if (!drag) return;
    if (drag.kind === "tunnel") {
      if (!insert) return; // dropped off any group → cancel
      e.preventDefault();
      this.#onMoveTunnel(drag.id, insert.groupId, insert.beforeId);
    } else if (
      drag.kind === "group" &&
      headerOnly &&
      dropSection &&
      dropSection !== drag.id &&
      this.#groups.some((g) => g.id === dropSection)
    ) {
      e.preventDefault();
      this.#onReorderGroups(drag.id, dropSection);
    }
  }

  #onListDragLeave(e) {
    // Only when the pointer truly leaves the list (not moving between its rows).
    if (e.relatedTarget && this.#listEl.contains(e.relatedTarget)) return;
    this.#clearDropHighlight();
    this.#clearPlaceholder();
  }

  // ── Drop gap (the "blank entry") ─────────────────────────────────────────────

  #ensurePlaceholder() {
    if (!this.#placeholder) {
      this.#placeholder = el("div", {
        class: "tunnel-row-placeholder",
        "aria-hidden": "true",
      });
    }
    return this.#placeholder;
  }

  /** Put the gap before/after `rowEl` by which half the pointer is over. */
  #gapAtRow(rowEl, clientY) {
    const ph = this.#ensurePlaceholder();
    if (ph.parentNode) ph.remove();
    const rect = rowEl.getBoundingClientRect();
    const after =
      Number.isFinite(clientY) && clientY > rect.top + rect.height / 2;
    this.#listEl.insertBefore(ph, after ? rowEl.nextSibling : rowEl);
    // The gap now stands in for the item, so collapse the item's original slot.
    this.#setDraggedHidden(true);
    this.#recordInsert(rowEl.dataset.section);
  }

  /** Put the gap at the very top of a group (just under its header). */
  #gapAtHeader(headerEl) {
    const ph = this.#ensurePlaceholder();
    if (ph.parentNode) ph.remove();
    this.#listEl.insertBefore(ph, headerEl.nextSibling);
    this.#setDraggedHidden(true);
    this.#recordInsert(headerEl.dataset.section);
  }

  /** Collapse (or restore) the dragged tunnel's own row while a gap stands in. */
  #setDraggedHidden(hidden) {
    if (this.#drag?.kind !== "tunnel") return;
    this.#rows
      .get(this.#drag.id)
      ?.root.classList.toggle("tunnel-row--dragging", hidden);
  }

  /** Derive { groupId, beforeId } from where the gap now sits within its section. */
  #recordInsert(sectionId) {
    let n = this.#placeholder.nextElementSibling;
    // Skip over the dragged source row if it's the immediate follower (it's moving).
    const draggedId = this.#drag?.id;
    while (
      n &&
      n.classList?.contains("tunnel-row") &&
      n.dataset.id === draggedId
    ) {
      n = n.nextElementSibling;
    }
    const beforeId =
      n &&
      n.classList?.contains("tunnel-row") &&
      n.dataset.section === sectionId
        ? n.dataset.id
        : null; // end of the section
    this.#insert = {
      groupId: sectionId === UNGROUPED_ID ? null : sectionId,
      beforeId,
    };
  }

  /** Is the pointer still vertically within the active drop section's band? */
  #pointerWithinDropSection(clientY) {
    if (this.#dropSectionId == null || !Number.isFinite(clientY)) return false;
    const sec = this.#sections.get(this.#dropSectionId);
    if (!sec?.header) return false;
    let top = sec.header.getBoundingClientRect().top;
    let bottom = sec.header.getBoundingClientRect().bottom;
    const extend = (node) => {
      const r = node.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) return; // hidden (the dragged row) / unlaid
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    };
    for (const rec of this.#rows.values())
      if (rec.sectionId === this.#dropSectionId) extend(rec.root);
    if (this.#placeholder?.parentNode) extend(this.#placeholder);
    return clientY >= top && clientY <= bottom;
  }

  #clearPlaceholder() {
    if (this.#placeholder?.parentNode) this.#placeholder.remove();
    // No gap → the item occupies its own slot again (e.g. dragged off any group).
    this.#setDraggedHidden(false);
    this.#insert = null;
  }

  /** Mark a section as the live drop target (whole group, or header-only). */
  #showDrop(sectionId, headerOnly) {
    if (
      this.#dropSectionId === sectionId &&
      this.#dropHeaderOnly === headerOnly
    )
      return;
    this.#clearDropHighlight();
    this.#dropSectionId = sectionId;
    this.#dropHeaderOnly = headerOnly;
    this.#sections.get(sectionId)?.header?.classList.add("group-header--drop");
    if (!headerOnly) {
      for (const rec of this.#rows.values()) {
        if (rec.sectionId === sectionId)
          rec.root.classList.add("tunnel-row--drop");
      }
    }
  }

  #clearDropHighlight() {
    if (this.#dropSectionId == null) return;
    this.#sections
      .get(this.#dropSectionId)
      ?.header?.classList.remove("group-header--drop");
    for (const rec of this.#rows.values())
      rec.root.classList.remove("tunnel-row--drop");
    this.#dropSectionId = null;
    this.#dropHeaderOnly = false;
  }

  #clearDrag() {
    this.#clearDropHighlight();
    this.#clearPlaceholder();
    if (this.#drag?.kind === "tunnel") {
      this.#rows
        .get(this.#drag.id)
        ?.root.classList.remove("tunnel-row--dragging");
    }
    this.#drag = null;
    for (const rec of this.#sections.values()) {
      rec.header?.classList.remove("group-header--dragging");
    }
  }
}

/** Coerce a Set | array | falsy into a Set. */
function toSet(v) {
  if (v instanceof Set) return v;
  return new Set(Array.isArray(v) ? v : []);
}
