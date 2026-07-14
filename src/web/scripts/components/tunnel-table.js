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
// The fixed first column is the tunnel identity (status dot · local port · name,
// with edit/delete on hover); the remaining columns are the SAME metric cards the
// detail view shows, in the SAME shared order (card-catalog.js), so the "Cards"
// checklist doubles as the column chooser. Clicking a header sorts by that column
// (clicking the sorted one reverses); dragging a metric header reorders columns
// (which persists as the shared card order). A pure view: data + live snapshots
// are fed in, and selection / add / edit / delete / sort / column-order changes
// are reported back through constructor callbacks.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import {
  getCard,
  DEFAULT_CARD_ORDER,
  visibleCards,
  reorderCards,
  cardLabel,
  cardToneClasses,
} from "./card-catalog.js";
import { CardMenu } from "./card-menu.js";
import { dotState } from "./tunnel-list.js";

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
  #jumpsById = new Map();
  #selectedId = null;
  #visible = [...DEFAULT_CARD_ORDER]; // ordered VISIBLE columns (= shared cards)
  #sort = { key: TABLE_TUNNEL_COLUMN, dir: "asc" };
  #rowNodes = new Map(); // id → { tr, dot, cells: Map<colKey, td> }
  #dragCol = null;

  #now;
  #onSelect;
  #onAdd;
  #onEdit;
  #onCardsChange;
  #onSortChange;
  #onToggleArm;
  #onTogglePause;
  #onContextMenu;

  constructor({
    now,
    onSelect,
    onAdd,
    onEdit,
    onCardsChange,
    onSortChange,
    onToggleArm,
    onTogglePause,
    onContextMenu,
  } = {}) {
    this.#now = now || Date.now;
    this.#onSelect = onSelect || (() => {});
    this.#onAdd = onAdd || (() => {});
    this.#onEdit = onEdit || (() => {});
    this.#onCardsChange = onCardsChange || (() => {});
    this.#onSortChange = onSortChange || (() => {});
    this.#onToggleArm = onToggleArm || (() => {});
    this.#onTogglePause = onTogglePause || (() => {});
    this.#onContextMenu = onContextMenu || (() => {});
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
    this.#armBtn = el("button", {
      class: "btn--icon detail-ctrl detail-arm-btn",
      type: "button",
      html: icons.power(),
      onClick: () => this.#selectedId && this.#onToggleArm(this.#selectedId),
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
  setData(defs, states, snaps, selectedId, jumpsById) {
    this.#defs = Array.isArray(defs) ? defs : [];
    if (states instanceof Map) this.#states = states;
    if (snaps instanceof Map) this.#snaps = snaps;
    if (jumpsById instanceof Map) this.#jumpsById = jumpsById;
    if (selectedId !== undefined) this.#selectedId = selectedId;
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

  getSort() {
    return { ...this.#sort };
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
    this.#updateControls();
  }

  /** A discrete state change: refresh that row's dot + cells in place. */
  updateState(id, state) {
    this.#states.set(id, state);
    this.#refreshValues();
    this.#updateControls();
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

    const cols = [TABLE_TUNNEL_COLUMN, ...this.#visible];
    for (const col of cols) this.#theadRow.appendChild(this.#buildHeader(col));

    const rows = this.#sortedRows();
    const empty = rows.length === 0;
    this.#emptyEl.hidden = !empty;
    this.#tableEl.hidden = empty;

    for (const def of rows) {
      const rec = this.#buildRow(def);
      this.#rowNodes.set(def.id, rec);
      this.#tbody.appendChild(rec.tr);
    }
    this.#refreshValues();
    this.setSelected(this.#selectedId);
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

  #buildRow(def) {
    const id = def.id;
    const dot = el("span", { class: "tunnel-dot" });
    // Only Edit lives inline; Delete is reachable from the row context menu.
    const tools = el("div", { class: "tunnel-row-tools" }, [
      el("button", {
        class: "btn--icon tunnel-row-btn tunnel-edit-btn",
        type: "button",
        title: t("tunnels.edit"),
        "aria-label": t("tunnels.edit"),
        html: icons.edit(),
        onClick: (e) => {
          e.stopPropagation();
          this.#onEdit(id);
        },
      }),
    ]);

    const identityCell = el("td", { class: "tt-td tt-td--identity" }, [
      el("div", { class: "tt-identity" }, [
        dot,
        el("span", {
          class: "tunnel-row-port",
          text: String(def.localPort ?? "—"),
        }),
        el("span", {
          class: "tunnel-row-name",
          text: def.name || t("def.unnamed"),
        }),
        tools,
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
        dataset: { id },
        tabindex: "0",
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
      },
      [identityCell, ...metricCells],
    );

    return { tr, dot, cells };
  }

  /** Recompute every visible cell (+ dot) in place — no re-sort. */
  #refreshValues() {
    const now = this.#now();
    for (const [id, rec] of this.#rowNodes) {
      const state = this.#states.get(id) || "disarmed";
      const snap = this.#snaps.get(id) || null;
      const ctx = { snap, now, state };
      rec.dot.className = `tunnel-dot tunnel-dot--${dotState(state)}`;
      rec.dot.title = t(`state.${state}`);
      for (const [colKey, cell] of rec.cells) {
        const card = getCard(colKey);
        if (!card) continue;
        cell.textContent = card.value(ctx);
        cell.className = "tt-td tt-td--metric";
        for (const cls of cardToneClasses(card, ctx)) cell.classList.add(cls);
      }
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
    this.#armBtn.classList.toggle("detail-arm-btn--armed", armed);
    this.#armBtn.innerHTML = armed ? icons.power() : icons.powerOff();
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
