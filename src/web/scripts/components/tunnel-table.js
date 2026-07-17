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

// tunnel-table.js — the "list" view: every tunnel as a row in one sortable table.
// The fixed first column is the tunnel identity (three-lamp status signal · name);
// the remaining columns are the SAME metric cards the detail view shows, in the
// SAME shared order (card-catalog.js), so the "Cards" checklist doubles as the
// column chooser. Clicking a header sorts by that column (clicking the sorted one
// reverses); dragging a metric header reorders columns (which persists as the
// shared card order). Row actions (edit, delete, …) live on the right-click
// context menu. A pure view: data + live snapshots are fed in, and selection /
// add / sort / column-order changes are reported back through constructor
// callbacks.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import { formatRate } from "../utils/format.js";
import {
  getCard,
  DEFAULT_CARD_ORDER,
  visibleCards,
  reorderCards,
  cardLabel,
  cardToneClasses,
} from "./card-catalog.js";
import { CardMenu } from "./card-menu.js";
import { signalLamp, buildSignal, typeIcon } from "./tunnel-list.js";
import { newScheduleBadge, renderScheduleBadge } from "./schedule-badge.js";
import {
  buildSections,
  sectionRollup,
  sectionThroughput,
  sectionPauseRollup,
  sectionPauseState,
  groupColorKey,
} from "./tunnel-grouping.js";

/** The synthetic key of the fixed identity column (sorts by tunnel name). */
export const TABLE_TUNNEL_COLUMN = "__tunnel";

/** Armed = the engine holds this tunnel (anything but disarmed / error). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

/** Coerce a persisted sort value to a valid `{ key, dir }`. */
export function normalizeSort(sort) {
  const key =
    sort && typeof sort.key === "string" ? sort.key : TABLE_TUNNEL_COLUMN;
  const dir = sort && sort.dir === "desc" ? "desc" : "asc";
  return { key, dir };
}

export class TunnelTable {
  #el;
  #theadRow;
  #tbody;
  #tableEl;
  #emptyEl;
  #cardMenu;
  #armBtn;
  #pauseBtn;

  #defs = [];
  #states = new Map();
  #snaps = new Map();
  #selectedId = null;
  #visible = [...DEFAULT_CARD_ORDER]; // ordered VISIBLE columns (= shared cards)
  #sort = { key: TABLE_TUNNEL_COLUMN, dir: "asc" };
  #rowNodes = new Map(); // id → { tr, signal, cells: Map<colKey, td> }
  #sectionNodes = new Map(); // sectionId → { headerTr, rollupEl, trafficEl, armSwitch, pauseBtn, defs }
  #dragCol = null;

  // Grouping (Feature 140): empty groups → flat table, unchanged.
  #groups = [];
  #collapsedIds = new Set();
  #drag = null; // row/header drag ({ kind, id }); distinct from #dragCol (columns)
  #dropSectionId = null; // section currently shown as the drop target
  #dropHeaderOnly = false; // true → only the header row highlights (group reorder)

  #now;
  #onSelect;
  #onAdd;
  #onCardsChange;
  #onSortChange;
  #onToggleArm;
  #onTogglePause;
  #onContextMenu;
  #onToggleCollapse;
  #onGroupAction;
  #onGroupMenu;
  #onAssignToGroup;
  #onReorderGroups;

  constructor({
    now,
    onSelect,
    onAdd,
    onCardsChange,
    onSortChange,
    onToggleArm,
    onTogglePause,
    onContextMenu,
    onToggleCollapse,
    onGroupAction,
    onGroupMenu,
    onAssignToGroup,
    onReorderGroups,
  } = {}) {
    this.#now = now || Date.now;
    this.#onSelect = onSelect || (() => {});
    this.#onAdd = onAdd || (() => {});
    this.#onCardsChange = onCardsChange || (() => {});
    this.#onSortChange = onSortChange || (() => {});
    this.#onToggleArm = onToggleArm || (() => {});
    this.#onTogglePause = onTogglePause || (() => {});
    this.#onContextMenu = onContextMenu || (() => {});
    this.#onToggleCollapse = onToggleCollapse || (() => {});
    this.#onGroupAction = onGroupAction || (() => {});
    this.#onGroupMenu = onGroupMenu || (() => {});
    this.#onAssignToGroup = onAssignToGroup || (() => {});
    this.#onReorderGroups = onReorderGroups || (() => {});
    this.#cardMenu = new CardMenu({
      visible: () => this.#visible,
      onToggle: (key, show) => this.#toggleColumn(key, show),
    });
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  #build() {
    const addBtn = el("button", {
      class: "btn--icon tunnel-add-btn",
      type: "button",
      title: t("tunnels.add"),
      "aria-label": t("tunnels.add"),
      html: icons.add(),
      onClick: () => this.#onAdd(),
    });

    // Arm / pause controls for the SELECTED row — the list-view equivalent of
    // the detail header's controls (they're empty/disabled until a row is picked).
    // Arm/disarm is a checkbox styled as a slider switch (see .detail-arm-switch):
    // checked = armed (green track), unchecked = disarmed (red track).
    this.#armBtn = el("input", {
      class: "detail-arm-switch",
      type: "checkbox",
      role: "switch",
      onChange: () => this.#selectedId && this.#onToggleArm(this.#selectedId),
    });
    this.#pauseBtn = el("button", {
      class: "btn--icon detail-ctrl detail-pause-btn",
      type: "button",
      html: icons.pause(),
      onClick: () => this.#selectedId && this.#onTogglePause(this.#selectedId),
    });

    const toolbar = el("div", { class: "tunnel-table-toolbar" }, [
      el("span", { class: "tunnel-table-title", text: t("tunnels.title") }),
      addBtn,
      el("span", { class: "tunnel-table-spacer" }),
      this.#cardMenu.element,
      this.#pauseBtn,
      this.#armBtn,
    ]);

    this.#theadRow = el("tr", { class: "tt-head-row" });
    this.#tbody = el("tbody", { class: "tt-body" });
    this.#tableEl = el("table", { class: "tunnel-table" }, [
      el("thead", {}, [this.#theadRow]),
      this.#tbody,
    ]);

    this.#emptyEl = el("div", { class: "tunnel-table-empty", hidden: true }, [
      el("p", {
        class: "tunnel-list-empty-title",
        text: t("tunnels.empty"),
      }),
      el("p", {
        class: "tunnel-list-empty-hint",
        text: t("tunnels.emptyHint"),
      }),
    ]);

    return el("div", { class: "tunnel-table-view" }, [
      toolbar,
      el("div", { class: "tunnel-table-scroll" }, [this.#tableEl]),
      this.#emptyEl,
    ]);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Feed definitions + live maps and (re)render (sorts + rebuilds). */
  setData(defs, states, snaps, selectedId) {
    this.#defs = Array.isArray(defs) ? defs : [];
    if (states instanceof Map) this.#states = states;
    if (snaps instanceof Map) this.#snaps = snaps;
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

  /** Adopt the persisted visible-card set as the column order (rebuilds). */
  setCardOrder(order) {
    this.#visible = visibleCards(order);
    this.#cardMenu.sync(this.#visible);
    this.#render();
  }

  /** Adopt the persisted sort `{ key, dir }` (re-sorts). */
  setSort(sort) {
    this.#sort = normalizeSort(sort);
    this.#render();
  }

  /** Highlight the selected row (no re-render) and refresh its arm/pause controls. */
  setSelected(id) {
    this.#selectedId = id;
    for (const [rowId, rec] of this.#rowNodes) {
      const on = rowId === id;
      rec.tr.classList.toggle("tt-row--selected", on);
      rec.tr.setAttribute("aria-selected", String(on));
    }
    this.#updateControls();
  }

  /** Fold in fresh snapshots (+ their states); updates values in place. */
  applyStats(snaps, states) {
    if (snaps instanceof Map) this.#snaps = snaps;
    if (states instanceof Map) this.#states = states;
    this.#refreshValues();
    this.#refreshHeaders();
    this.#updateControls();
  }

  /** A discrete state change: relight that row's signal + refresh cells in place. */
  updateState(id, state) {
    this.#states.set(id, state);
    this.#refreshValues();
    this.#refreshHeaders();
    this.#updateControls();
  }

  /** Refresh every row's schedule badge from the store (Feature 150). */
  applySchedule() {
    for (const [id, rec] of this.#rowNodes) renderScheduleBadge(rec.sched, id);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** The active sort, falling back to identity if the key isn't a live column. */
  #effectiveSort() {
    const { key, dir } = this.#sort;
    const valid = key === TABLE_TUNNEL_COLUMN || this.#visible.includes(key);
    return { key: valid ? key : TABLE_TUNNEL_COLUMN, dir };
  }

  #render() {
    clear(this.#theadRow);
    clear(this.#tbody);
    this.#rowNodes.clear();
    this.#sectionNodes.clear();

    const cols = [TABLE_TUNNEL_COLUMN, ...this.#visible];
    for (const col of cols) this.#theadRow.appendChild(this.#buildHeader(col));

    const rows = this.#sortedRows();
    const empty = rows.length === 0;
    this.#emptyEl.hidden = !empty;
    this.#tableEl.hidden = empty;

    // Group into sections (buildSections keeps the sorted order within each), or
    // render flat when there are no groups.
    const sections = buildSections(rows, this.#groups, this.#collapsedIds);
    if (!sections) {
      for (const def of rows) this.#appendRow(def, null);
    } else {
      const colspan = cols.length;
      for (const section of sections) {
        this.#tbody.appendChild(this.#buildGroupHeaderRow(section, colspan));
        if (!section.collapsed) {
          for (const def of section.defs) this.#appendRow(def, section);
        }
      }
    }
    this.#refreshValues();
    this.#refreshHeaders();
    this.setSelected(this.#selectedId);
  }

  #appendRow(def, section) {
    const rec = this.#buildRow(def, section);
    this.#rowNodes.set(def.id, rec);
    this.#tbody.appendChild(rec.tr);
  }

  #sortedRows() {
    const { key, dir } = this.#effectiveSort();
    const now = this.#now();
    const keyOf = (def) => {
      if (key === TABLE_TUNNEL_COLUMN) return (def.name || "").toLowerCase();
      const card = getCard(key);
      if (!card) return 0;
      const state = this.#states.get(def.id) || "disarmed";
      const snap = this.#snaps.get(def.id) || null;
      return card.sortValue({ snap, now, state });
    };
    const byName = (a, b) =>
      (a.name || "").localeCompare(b.name || "") ||
      String(a.id).localeCompare(String(b.id));

    return [...this.#defs].sort((a, b) => {
      const av = keyOf(a);
      const bv = keyOf(b);
      let cmp;
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      cmp = dir === "desc" ? -cmp : cmp;
      // Stable tie-break by name then id, ascending regardless of direction.
      return cmp !== 0 ? cmp : byName(a, b);
    });
  }

  #buildHeader(colKey) {
    const isIdentity = colKey === TABLE_TUNNEL_COLUMN;
    const { key: activeKey, dir } = this.#effectiveSort();
    const active = activeKey === colKey;
    const label = isIdentity ? t("table.tunnel") : cardLabel(colKey);

    const props = {
      class:
        `tt-th${isIdentity ? " tt-th--identity" : ""}` +
        `${active ? " tt-th--sorted" : ""}`,
      scope: "col",
      dataset: { col: colKey },
      "aria-sort": active
        ? dir === "asc"
          ? "ascending"
          : "descending"
        : "none",
      title: t("table.sortHint", { name: label }),
      onClick: () => this.#onHeaderClick(colKey),
    };
    if (!isIdentity) {
      props.draggable = "true";
      props.onDragstart = (e) => this.#onHeaderDragStart(e, colKey);
      props.onDragover = (e) => this.#onHeaderDragOver(e, colKey);
      props.onDragleave = (e) =>
        e.currentTarget.classList.remove("tt-th--drop");
      props.onDrop = (e) => this.#onHeaderDrop(e, colKey);
      props.onDragend = () => this.#clearHeaderMarks();
    }

    // The label + sort arrow live in an inner flex box (see .tt-th-inner): a
    // sticky <th> defeats vertical-align, so the flex box does the bottom/left
    // alignment while the cell stays sticky.
    return el("th", props, [
      el("div", { class: "tt-th-inner" }, [
        el("span", { class: "tt-th-label", text: label }),
        el("span", {
          class: "tt-th-arrow",
          "aria-hidden": "true",
          text: active ? (dir === "asc" ? "▲" : "▼") : "",
        }),
      ]),
    ]);
  }

  #buildRow(def, section) {
    const id = def.id;
    const signal = buildSignal(this.#states.get(id) || "disarmed");
    // Feature 150: the scheduled-tunnel badge (empty/hidden when not governed).
    const sched = newScheduleBadge(id);
    // Row actions (edit, delete, …) all live on the right-click context menu, so
    // the identity cell carries no inline buttons.
    const identityCell = el("td", { class: "tt-td tt-td--identity" }, [
      el("div", { class: "tt-identity" }, [
        signal,
        typeIcon(def),
        el("span", {
          class: "tunnel-row-name",
          text: def.name || t("def.unnamed"),
        }),
        sched,
      ]),
    ]);

    const cells = new Map();
    const metricCells = this.#visible.map((colKey) => {
      const cell = el("td", { class: "tt-td tt-td--metric" });
      cells.set(colKey, cell);
      return cell;
    });

    const tr = el(
      "tr",
      {
        class: "tt-row",
        // The section id lets a row act as a drop target for its whole group.
        dataset: section ? { id, section: section.id } : { id },
        tabindex: "0",
        draggable: "true",
        onClick: () => this.#onSelect(id),
        onKeydown: (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            this.#onSelect(id);
          }
        },
        // Secondary (right) click opens the native OS row menu.
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onContextMenu(id);
        },
        onDragstart: (e) => this.#onRowDragStart(e, id),
        onDragend: () => this.#clearRowDrag(),
        // Drag a row onto any tunnel in an expanded group to assign it there.
        ...(section
          ? {
              onDragover: (e) => this.#onDataRowDragOver(e, section),
              onDrop: (e) => this.#onDataRowDrop(e, section),
            }
          : {}),
      },
      [identityCell, ...metricCells],
    );

    return { tr, signal, sched, cells, sectionId: section ? section.id : null };
  }

  /** A group section header spanning the whole table (Feature 140). */
  #buildGroupHeaderRow(section, colspan) {
    const group = section.group;
    const rollup = sectionRollup(section.defs, this.#states);
    const name = group ? group.label : t("group.ungrouped");

    const chevron = el("button", {
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
    const trafficEl = el("span", { class: "group-traffic" });

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

    // The group name + its controls live in a single cell pinned to the name
    // (identity) column — name on the left, count/traffic/pause/switch on the
    // right — matching the cards-view sidebar header. An empty filler spans the
    // remaining metric columns so the header band still reaches the right edge.
    const identityCell = el(
      "td",
      { class: "tt-group-cell tt-group-cell--identity" },
      [
        el("div", { class: "group-header-inner" }, [
          chevron,
          swatch,
          nameEl,
          rollupEl,
          trafficEl,
          pauseBtn,
          armSwitch,
        ]),
      ],
    );
    const filler =
      colspan > 1
        ? el("td", {
            class: "tt-group-cell tt-group-cell--rest",
            colspan: String(colspan - 1),
            "aria-hidden": "true",
          })
        : null;

    const tr = el(
      "tr",
      {
        class: `tt-group-row${section.collapsed ? " tt-group-row--collapsed" : ""}`,
        dataset: { section: section.id },
        "aria-expanded": String(!section.collapsed),
        draggable: group ? "true" : null,
        onClick: () => this.#onToggleCollapse(section.id),
        onContextmenu: (e) => {
          e.preventDefault();
          this.#onGroupMenu(section.id);
        },
        onDragstart: group
          ? (e) => this.#onGroupDragStart(e, group.id)
          : undefined,
        onDragover: (e) => this.#onGroupDragOver(e, section),
        onDrop: (e) => this.#onGroupDrop(e, section),
        onDragend: () => this.#clearRowDrag(),
      },
      [identityCell, filler],
    );

    this.#sectionNodes.set(section.id, {
      headerTr: tr,
      rollupEl,
      trafficEl,
      armSwitch,
      pauseBtn,
      defs: section.defs,
    });
    return tr;
  }

  /** Recompute every visible cell (+ dot) in place — no re-sort. */
  #refreshValues() {
    const now = this.#now();
    for (const [id, rec] of this.#rowNodes) {
      const state = this.#states.get(id) || "disarmed";
      const snap = this.#snaps.get(id) || null;
      const ctx = { snap, now, state };
      const lamp = signalLamp(state);
      rec.signal.className = `tunnel-signal${lamp === "off" ? "" : ` tunnel-signal--${lamp}`}`;
      rec.signal.title = t(`state.${state}`);
      rec.signal.setAttribute("aria-label", t(`state.${state}`));
      for (const [colKey, cell] of rec.cells) {
        const card = getCard(colKey);
        if (!card) continue;
        cell.textContent = card.value(ctx);
        cell.className = "tt-td tt-td--metric";
        for (const cls of cardToneClasses(card, ctx)) cell.classList.add(cls);
      }
    }
  }

  /** Recompute each group header's rollup, traffic + arm/pause controls in place. */
  #refreshHeaders() {
    for (const [, rec] of this.#sectionNodes) {
      const rollup = sectionRollup(rec.defs, this.#states);
      rec.rollupEl.textContent = t("group.count", {
        armed: rollup.armed,
        total: rollup.total,
      });
      const flow = sectionThroughput(rec.defs, this.#snaps);
      rec.trafficEl.textContent =
        flow.up || flow.down
          ? t("group.traffic", {
              up: formatRate(flow.up),
              down: formatRate(flow.down),
            })
          : "";
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

  // ── Row / group-header drag (assign + reorder) ────────────────────────────────

  #onRowDragStart(e, id) {
    this.#drag = { kind: "tunnel", id };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", id);
      } catch {
        // ignore — jsdom / restricted environments
      }
    }
  }

  #onGroupDragStart(e, groupId) {
    this.#drag = { kind: "group", id: groupId };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", groupId);
      } catch {
        // ignore
      }
    }
    e.currentTarget.classList.add("tt-group-row--dragging");
  }

  #onGroupDragOver(e, section) {
    const drag = this.#drag;
    if (!drag) return;
    // A tunnel targets the whole (expanded) group; a group reorder targets only a
    // DIFFERENT real group header row.
    if (drag.kind === "tunnel") {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.#showDrop(section.id, false);
    } else if (
      drag.kind === "group" &&
      section.group &&
      section.group.id !== drag.id
    ) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.#showDrop(section.id, true);
    }
  }

  #onGroupDrop(e, section) {
    e.preventDefault();
    const drag = this.#drag;
    this.#clearRowDrag();
    if (!drag) return;
    if (drag.kind === "tunnel") {
      this.#assignTunnelToSection(drag.id, section);
    } else if (
      drag.kind === "group" &&
      section.group &&
      section.group.id !== drag.id
    ) {
      this.#onReorderGroups(drag.id, section.group.id);
    }
  }

  // A tunnel dragged over any row in an expanded group targets that whole group.
  #onDataRowDragOver(e, section) {
    if (this.#drag?.kind !== "tunnel") return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    this.#showDrop(section.id, false);
  }

  #onDataRowDrop(e, section) {
    e.preventDefault();
    const drag = this.#drag;
    this.#clearRowDrag();
    if (drag?.kind === "tunnel") this.#assignTunnelToSection(drag.id, section);
  }

  /** Assign a dragged tunnel to a section's group, skipping a no-op re-assign. */
  #assignTunnelToSection(tunnelId, section) {
    const targetGroupId = section.group ? section.group.id : null;
    const def = this.#defs.find((d) => d.id === tunnelId);
    const currentGroupId =
      def && def.groupId && this.#groups.some((g) => g.id === def.groupId)
        ? def.groupId
        : null;
    if (currentGroupId === targetGroupId) return; // already in this group
    this.#onAssignToGroup(tunnelId, targetGroupId);
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
    this.#sectionNodes
      .get(sectionId)
      ?.headerTr?.classList.add("tt-group-row--drop");
    if (!headerOnly) {
      for (const rec of this.#rowNodes.values()) {
        if (rec.sectionId === sectionId) rec.tr.classList.add("tt-row--drop");
      }
    }
  }

  #clearDropHighlight() {
    if (this.#dropSectionId == null) return;
    this.#sectionNodes
      .get(this.#dropSectionId)
      ?.headerTr?.classList.remove("tt-group-row--drop");
    for (const rec of this.#rowNodes.values())
      rec.tr.classList.remove("tt-row--drop");
    this.#dropSectionId = null;
    this.#dropHeaderOnly = false;
  }

  #clearRowDrag() {
    this.#drag = null;
    this.#clearDropHighlight();
    for (const rec of this.#sectionNodes.values()) {
      rec.headerTr?.classList.remove("tt-group-row--dragging");
    }
  }

  /** Reflect the SELECTED tunnel's state on the toolbar arm/pause controls
   *  (mirrors TunnelDetail#updateControls); disabled when nothing is selected. */
  #updateControls() {
    const hasSel =
      Boolean(this.#selectedId) &&
      this.#defs.some((d) => d.id === this.#selectedId);
    const state = hasSel
      ? this.#states.get(this.#selectedId) || "disarmed"
      : null;

    const armed = hasSel && isArmed(state);
    this.#armBtn.disabled = !hasSel;
    this.#armBtn.checked = armed;
    const armLabel = armed ? t("detail.disarm") : t("detail.arm");
    this.#armBtn.title = armLabel;
    this.#armBtn.setAttribute("aria-label", armLabel);

    const paused = state === "paused";
    const canPause = hasSel && (state === "connected" || paused);
    this.#pauseBtn.innerHTML = paused ? icons.play() : icons.pause();
    const pauseLabel = paused ? t("detail.resume") : t("detail.pause");
    this.#pauseBtn.title = pauseLabel;
    this.#pauseBtn.setAttribute("aria-label", pauseLabel);
    this.#pauseBtn.disabled = !canPause;
  }

  // ── Sorting ──────────────────────────────────────────────────────────────

  #onHeaderClick(colKey) {
    if (this.#effectiveSort().key === colKey) {
      const dir = this.#sort.dir === "asc" ? "desc" : "asc";
      this.#sort = { key: colKey, dir };
    } else {
      this.#sort = { key: colKey, dir: "asc" };
    }
    this.#render();
    this.#onSortChange({ ...this.#sort });
  }

  // ── Column drag-and-drop (metric headers only) ───────────────────────────

  #onHeaderDragStart(e, colKey) {
    this.#dragCol = colKey;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", colKey);
      } catch {
        // ignore — jsdom / restricted environments
      }
    }
    e.currentTarget.classList.add("tt-th--dragging");
  }

  #onHeaderDragOver(e, colKey) {
    if (!this.#dragCol || this.#dragCol === colKey) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    e.currentTarget.classList.add("tt-th--drop");
  }

  #onHeaderDrop(e, colKey) {
    e.preventDefault();
    const from = this.#dragCol;
    this.#clearHeaderMarks();
    if (!from || from === colKey) return;
    this.#visible = reorderCards(this.#visible, from, colKey);
    this.#render();
    this.#onCardsChange([...this.#visible]);
  }

  #clearHeaderMarks() {
    this.#dragCol = null;
    for (const th of this.#theadRow.querySelectorAll(".tt-th")) {
      th.classList.remove("tt-th--drop", "tt-th--dragging");
    }
  }

  // ── Column chooser (shared "Cards" checklist) ────────────────────────────

  #toggleColumn(key, show) {
    const shown = this.#visible.includes(key);
    if (show === shown) return;
    this.#visible = show
      ? [...this.#visible, key]
      : this.#visible.filter((k) => k !== key);
    this.#render();
    this.#onCardsChange([...this.#visible]);
  }
}

/** Coerce a Set | array | falsy into a Set. */
function toSet(v) {
  if (v instanceof Set) return v;
  return new Set(Array.isArray(v) ? v : []);
}
