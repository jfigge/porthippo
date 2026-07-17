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

// tunnels-view.js — the single master-detail surface that replaced the old
// Definition + Monitoring split. It owns the data (definitions, live states,
// stats snapshots, jump-host records for the breadcrumb) and the shared
// TunnelEditorDialog, and offers two presentations chosen by a header dropdown:
// "cards" (the master TunnelList + per-tunnel TunnelDetail) and "list" (the
// all-tunnels TunnelTable). Both share the persisted card order (columns) so the
// "Cards" checklist governs either view. All native work flows through
// `window.porthippo.*`; the existing dialogs are reused unchanged.

import { el } from "../dom.js";
import { t } from "../i18n.js";
import { PopupManager } from "../popup-manager.js";
import { TunnelEditorDialog } from "./tunnel-editor-dialog.js";
import { GroupEditorDialog } from "./group-editor-dialog.js";
import { TunnelList } from "./tunnel-list.js";
import { TunnelDetail } from "./tunnel-detail.js";
import { TunnelTable } from "./tunnel-table.js";
import { SplitResizer } from "./split-resizer.js";
import { buildErrorHistory } from "./error-history-dialog.js";
import { UNGROUPED_ID } from "./tunnel-grouping.js";

// The master list column's fallback width when no split position is stored yet
// (matches the CSS default). The list can't be dragged narrower than MIN_LEFT
// nor the detail pane narrower than MIN_RIGHT.
const DEFAULT_SPLIT_LEFT = 240;
const MIN_LEFT = 150;
const MIN_RIGHT = 300;

/** Armed = the engine holds this tunnel (anything but disarmed / error). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

export class TunnelsView {
  #el;
  #list;
  #detail;
  #table;
  #editor;
  #porthippo;
  #now;

  #split;
  #resizer;
  #listResizer;
  #tableEl;
  #mode = "cards";

  #defs = [];
  #states = new Map();
  #errors = new Map();
  #snaps = new Map();
  #jumpsById = new Map();
  #selectedId = null;
  #cardOrder = null;
  #cardLayout = null; // { [cardKey]: {col,row} } — ONE layout shared by every tunnel

  // Groups (Feature 140).
  #groups = [];
  #collapsed = new Set(); // collapsed section ids (persisted in settings)
  #groupEditor;
  #pendingAssignIds = null; // ids to move into a group being created via "New group…"
  #onGroupsChanged;

  #onStats;
  #onTunnelState;
  #onSetMode;
  #onScheduleUpdated;

  constructor({ porthippo, openKeyFile, now } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#now = now || Date.now;

    this.#editor = new TunnelEditorDialog({
      porthippo: this.#porthippo,
      openKeyFile,
      onSubmit: (payload, ctx) => this.#submit(payload, ctx),
      onSaved: (record) => this.#afterSaved(record),
    });

    this.#groupEditor = new GroupEditorDialog({
      porthippo: this.#porthippo,
      onSaved: (record) => this.#afterGroupSaved(record),
    });

    const groupCbs = {
      onToggleCollapse: (sectionId) => this.#toggleCollapse(sectionId),
      onGroupAction: (sectionId, action) =>
        this.#groupAction(sectionId, action),
      onGroupMenu: (sectionId) => this.#showGroupMenu(sectionId),
      onAssignToGroup: (tunnelId, groupId) =>
        this.#assignMany([tunnelId], groupId),
      onReorderGroups: (fromId, toId) => this.#reorderGroups(fromId, toId),
    };

    this.#list = new TunnelList({
      onSelect: (id) => this.#select(id),
      onAdd: () => this.#editor.openCreate(),
      // Edit, delete and the other row actions live on the row's right-click menu.
      onContextMenu: (id) => this.#showContextMenu(id),
      // Cards/treeview drag: assign to a group AND sequence within it.
      onMoveTunnel: (id, groupId, beforeId) =>
        this.#moveTunnel(id, groupId, beforeId),
      ...groupCbs,
    });

    this.#detail = new TunnelDetail({
      now: this.#now,
      onToggleArm: (id) => this.#toggleArm(id),
      onTogglePause: (id) => this.#togglePause(id),
      onCardsChange: (order) => this.#persistCardOrder(order),
      onLayoutChange: (positions) => this.#persistCardLayout(positions),
      onShowError: (id) => this.#showError(id),
      onShowErrors: (id) => this.#showErrorHistory(id),
    });

    this.#table = new TunnelTable({
      now: this.#now,
      onSelect: (id) => this.#select(id),
      onAdd: () => this.#editor.openCreate(),
      onDelete: (id) => this.#confirmDelete(id),
      onCardsChange: (order) => this.#persistCardOrder(order),
      onSortChange: (sort) => this.#persistListSort(sort),
      onToggleArm: (id) => this.#toggleArm(id),
      onTogglePause: (id) => this.#togglePause(id),
      onContextMenu: (id) => this.#showContextMenu(id),
      ...groupCbs,
    });

    this.#split = el("div", { class: "tunnels-split" }, [
      this.#list.element,
      this.#detail.element,
    ]);
    this.#tableEl = this.#table.element;

    // Both splitters write `--split-left` to the view root, so a single split
    // width is inherited by the Cards grid AND the List table — the divider
    // looks and behaves the same in either view.
    this.#el = el("div", { class: "tunnels-view" }, [
      this.#split,
      this.#tableEl,
      this.#editor.element,
      this.#groupEditor.element,
    ]);

    // Cards view: a draggable divider between the master list and the detail
    // cards. Its committed width is persisted so the split restores on launch.
    this.#resizer = new SplitResizer({
      container: this.#split,
      target: this.#el,
      minLeft: MIN_LEFT,
      minRight: MIN_RIGHT,
      label: t("tunnels.split.resize"),
      onCommit: (px) => this.#persistSplit(px),
    });
    this.#split.insertBefore(this.#resizer.element, this.#detail.element);

    // List view: the same split width fixes the tunnel-name column; an overlay
    // divider on the table drags the shared `--split-left` (persisted alike).
    this.#listResizer = new SplitResizer({
      container: this.#tableEl,
      target: this.#el,
      minLeft: MIN_LEFT,
      minRight: MIN_RIGHT,
      label: t("tunnels.split.resize"),
      onCommit: (px) => this.#persistSplit(px),
    });
    this.#listResizer.element.classList.add("tunnels-splitter--overlay");
    this.#tableEl.appendChild(this.#listResizer.element);

    this.#applyMode(); // default: cards

    this.#onStats = (e) => this.#applyStats(e.detail);
    this.#onTunnelState = (e) => this.#applyState(e.detail);
    // Feature 150: the scheduler re-evaluated — refresh the row schedule badges in
    // place (no full re-render, so scroll/selection are untouched).
    this.#onScheduleUpdated = () => this.#applySchedule();
    // The view-mode toggle lives in the app header; it broadcasts the intent
    // and we echo the resolved mode back so the toggle's glyph/hint stays in sync.
    this.#onSetMode = (e) => this.#setMode(e.detail && e.detail.mode);
    // A group create/edit/delete anywhere (this view's editor or another window)
    // re-reads the group list so both presentations refresh (Feature 140).
    this.#onGroupsChanged = () => this.load();
    window.addEventListener("porthippo:stats-updated", this.#onStats);
    window.addEventListener("porthippo:tunnel-state", this.#onTunnelState);
    window.addEventListener("porthippo:set-detail-mode", this.#onSetMode);
    window.addEventListener("porthippo:groups-changed", this.#onGroupsChanged);
    window.addEventListener(
      "porthippo:schedule-updated",
      this.#onScheduleUpdated,
    );
  }

  /** Refresh the schedule badge on every row + the detail breadcrumb. */
  #applySchedule() {
    this.#list.applySchedule();
    this.#table.applySchedule();
    this.#detail.applySchedule();
  }

  get element() {
    return this.#el;
  }

  /** Load definitions, jump hosts (breadcrumb), groups, live state, card order + mode. */
  async load() {
    const [defs, status, jumps, groups, settings] = await Promise.all([
      this.#porthippo?.tunnels?.list?.() ?? [],
      this.#porthippo?.tunnels?.status?.() ?? [],
      this.#porthippo?.jumpHosts?.list?.() ?? [],
      this.#porthippo?.groups?.list?.() ?? [],
      this.#porthippo?.settings?.get?.() ?? {},
    ]);
    this.#defs = Array.isArray(defs) ? defs : [];
    this.#groups = Array.isArray(groups) ? groups : [];
    if (Array.isArray(status)) {
      for (const s of status) {
        if (!s || !s.id) continue;
        this.#states.set(s.id, s.state);
        if (s.error) this.#errors.set(s.id, s.error);
        else this.#errors.delete(s.id);
      }
    }
    this.#jumpsById = new Map(
      (Array.isArray(jumps) ? jumps : []).map((j) => [j.id, j]),
    );
    // Always apply the (possibly null) order so both views default to all cards.
    this.#cardOrder =
      settings && Array.isArray(settings.cardOrder) ? settings.cardOrder : null;
    // The single shared card layout for the detail canvas (see #persistCardLayout),
    // migrating a legacy per-tunnel map if that's all that's stored.
    this.#cardLayout = this.#loadCardLayout(settings);
    this.#detail.setCardOrder(this.#cardOrder);
    this.#table.setCardOrder(this.#cardOrder);
    // Restore the persisted splitter position (falls back to the default width).
    // Both splitters share the one value so Cards and List stay in lockstep.
    const splitLeft = Number(settings?.splitLeft);
    const width = Number.isFinite(splitLeft) ? splitLeft : DEFAULT_SPLIT_LEFT;
    this.#resizer.setLeft(width);
    this.#listResizer.setLeft(width);
    if (settings && settings.listSort) this.#table.setSort(settings.listSort);
    // Always (re)apply so the header selector syncs, even for the default.
    this.#setMode(settings?.detailMode, { persist: false });

    // Per-group collapsed state (Feature 140): the persisted map of collapsed
    // section ids ({ [id]: true }); default all expanded.
    const collapsedMap =
      settings && typeof settings.groupCollapsed === "object"
        ? settings.groupCollapsed
        : {};
    this.#collapsed = new Set(
      Object.keys(collapsedMap).filter((k) => collapsedMap[k]),
    );

    // Keep the current selection if it still exists, else select the first tunnel.
    if (!this.#defs.some((d) => d.id === this.#selectedId)) {
      this.#selectedId = this.#defs[0]?.id ?? null;
    }
    this.#list.setData(this.#defs, this.#states, this.#selectedId);
    this.#table.setData(
      this.#defs,
      this.#states,
      this.#snaps,
      this.#selectedId,
    );
    this.#pushGrouping();
    this.#renderDetail();
  }

  /** Open a blank editor (menu/tray "New Tunnel"). */
  createNew() {
    this.#editor.openCreate();
  }

  /** Select + focus a tunnel by id (menu/tray edit affordance). */
  selectById(id) {
    if (this.#defs.some((d) => d.id === id)) this.#select(id);
  }

  destroy() {
    window.removeEventListener("porthippo:stats-updated", this.#onStats);
    window.removeEventListener("porthippo:tunnel-state", this.#onTunnelState);
    window.removeEventListener("porthippo:set-detail-mode", this.#onSetMode);
    window.removeEventListener(
      "porthippo:groups-changed",
      this.#onGroupsChanged,
    );
    window.removeEventListener(
      "porthippo:schedule-updated",
      this.#onScheduleUpdated,
    );
    this.#resizer.destroy();
    this.#listResizer.destroy();
  }

  // ── View mode ─────────────────────────────────────────────────────────────

  #setMode(mode, { persist = true } = {}) {
    const m = mode === "list" ? "list" : "cards";
    this.#mode = m;
    this.#applyMode();
    // Echo the resolved mode so the header <select> reflects it.
    window.dispatchEvent(
      new CustomEvent("porthippo:detail-mode-changed", { detail: { mode: m } }),
    );
    if (persist) {
      this.#porthippo?.settings?.set?.({ detailMode: m })?.catch?.(() => {});
    }
  }

  #applyMode() {
    const list = this.#mode === "list";
    this.#split.hidden = list;
    this.#tableEl.hidden = !list;
    this.#el.classList.toggle("tunnels-view--list", list);
    // A splitter's container is zero-width while its view is hidden, so re-clamp
    // the stored width against the now-measurable container the moment it shows.
    if (list) this.#listResizer.refresh();
    else this.#resizer.refresh();
  }

  // ── Selection ─────────────────────────────────────────────────────────────

  #editById(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (def) this.#editor.openEdit(def);
  }

  /**
   * Open a create editor prefilled with a copy of an existing tunnel — every
   * value carries over except the name, which is left blank and focused so the
   * user must name the copy before saving (the id is dropped, so the save is a
   * create, not an update).
   */
  #cloneById(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (def) this.#editor.openClone(def);
  }

  // ── Row context menu (native OS menu on secondary-click) ──────────────────

  /**
   * Pop the native OS context menu for a right-clicked tunnel row. Labels are
   * resolved here (Pause/Play + Arm/Disarm reflect the live state), sent to main
   * as a plain template, and the chosen item id is dispatched to the same
   * actions the row buttons use. Selecting the row first keeps the detail view
   * (and the list-view arm/pause controls) pointed at the menu's target.
   */
  async #showContextMenu(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    this.#select(id);

    const state = this.#states.get(id) || "disarmed";
    const armed = isArmed(state);
    const paused = state === "paused";
    const canPause = state === "connected" || paused;

    const items = [
      { id: "edit", label: t("tunnels.menu.edit") },
      { type: "separator" },
      {
        id: "pause",
        label: paused ? t("tunnels.menu.play") : t("tunnels.menu.pause"),
        enabled: canPause,
      },
      {
        id: "arm",
        label: armed ? t("tunnels.menu.disarm") : t("tunnels.menu.arm"),
      },
      { type: "separator" },
      // Feature 140: move this tunnel between groups (or create one).
      {
        label: t("tunnels.menu.assign"),
        submenu: this.#assignMenuItems(def.groupId || null),
      },
      { id: "clone", label: t("tunnels.menu.clone") },
      { type: "separator" },
      { id: "delete", label: t("tunnels.menu.delete") },
    ];

    const action = await this.#porthippo?.contextMenu?.popup?.({ items });
    switch (action) {
      case "edit":
        this.#editById(id);
        break;
      case "pause":
        this.#togglePause(id);
        break;
      case "arm":
        this.#toggleArm(id);
        break;
      case "clone":
        this.#cloneById(id);
        break;
      case "delete":
        this.#confirmDelete(id);
        break;
      default:
        // A submenu choice ("assign:<target>") lands here; anything else is a
        // dismissal (null) or an unknown id.
        if (typeof action === "string" && action.startsWith("assign:")) {
          this.#handleAssignChoice(action, [id]);
        }
        break;
    }
  }

  #select(id) {
    this.#selectedId = id;
    this.#list.setSelected(id);
    this.#table.setSelected(id);
    this.#renderDetail();
  }

  #renderDetail() {
    const def = this.#defs.find((d) => d.id === this.#selectedId);
    if (!def) {
      this.#detail.clear();
      return;
    }
    this.#detail.show(def, {
      state: this.#states.get(def.id) || "disarmed",
      snap: this.#snaps.get(def.id) || null,
      jumpsById: this.#jumpsById,
      layout: this.#cardLayout, // one layout shared by every tunnel
    });
  }

  // ── Live data ─────────────────────────────────────────────────────────────

  #applyStats(detail) {
    const stats = detail && detail.stats;
    this.#snaps = stats instanceof Map ? stats : new Map();
    for (const snap of this.#snaps.values()) {
      if (!snap || !snap.id) continue;
      this.#states.set(snap.id, snap.state);
      if (snap.error) this.#errors.set(snap.id, snap.error);
      else this.#errors.delete(snap.id);
      this.#list.updateState(snap.id, snap.state);
    }
    this.#table.applyStats(this.#snaps, this.#states);
    if (this.#selectedId) {
      this.#detail.updateSnap(
        this.#snaps.get(this.#selectedId) || null,
        this.#states.get(this.#selectedId),
      );
    }
  }

  #applyState(detail) {
    // Feature 140: a group action coalesces into ONE broadcast carrying an ARRAY of
    // snapshots; a single tunnel change is still a lone object. Normalise to a list.
    if (Array.isArray(detail)) {
      for (const one of detail) this.#applyOneState(one);
      return;
    }
    this.#applyOneState(detail);
  }

  #applyOneState(detail) {
    if (!detail || !detail.id) return;
    if (detail.removed) {
      this.#states.delete(detail.id);
      this.#errors.delete(detail.id);
    } else {
      this.#states.set(detail.id, detail.state);
      if (detail.error) this.#errors.set(detail.id, detail.error);
      else this.#errors.delete(detail.id);
      this.#list.updateState(detail.id, detail.state);
      this.#table.updateState(detail.id, detail.state);
    }
    if (detail.id === this.#selectedId) {
      this.#detail.updateState(this.#states.get(detail.id) || "disarmed");
    }
  }

  // ── Store writes (reuse the existing dialogs) ─────────────────────────────

  #submit(payload, { id }) {
    return id
      ? this.#porthippo.tunnels.update(id, payload)
      : this.#porthippo.tunnels.create(payload);
  }

  async #afterSaved(record) {
    window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
    if (record && record.id) this.#selectedId = record.id; // focus the saved tunnel
    await this.load();
  }

  #confirmDelete(id) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    PopupManager.confirmDelete({
      message: t("def.delete.message", { name: def.name || t("def.unnamed") }),
      onConfirm: async () => {
        const result = await this.#porthippo.tunnels.delete(id);
        if (result && result.__hippoError) {
          PopupManager.notify({ message: result.message || "Delete failed" });
          return;
        }
        window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
        if (this.#selectedId === id) this.#selectedId = null;
        await this.load();
      },
    });
  }

  async #toggleArm(id) {
    const armed = isArmed(this.#states.get(id) || "disarmed");
    // Optimistic: reflect the intent; a state broadcast corrects it on success. A
    // refused intent yields no broadcast, so restore the prior state on error.
    const prev = this.#states.get(id) || "disarmed";
    const next = armed ? "disarmed" : "listening";
    this.#setLiveState(id, next);
    const result = await (armed
      ? this.#porthippo?.tunnels?.disarm?.(id)
      : this.#porthippo?.tunnels?.arm?.(id));
    if (result && result.__hippoError) {
      this.#setLiveState(id, prev);
      PopupManager.notify({ message: result.message || "Engine error" });
    }
  }

  async #togglePause(id) {
    const state = this.#states.get(id) || "disarmed";
    if (state !== "connected" && state !== "paused") return;
    const result = await (state === "paused"
      ? this.#porthippo?.tunnels?.resume?.(id)
      : this.#porthippo?.tunnels?.pause?.(id));
    if (result && result.__hippoError) {
      PopupManager.notify({ message: result.message || "Engine error" });
    }
  }

  /** Open the full error for a tunnel (fired by clicking its errored State card). */
  #showError(id) {
    const def = this.#defs.find((d) => d.id === id);
    PopupManager.notify({
      title: t("error.dialog.title", {
        name: (def && def.name) || t("def.unnamed"),
      }),
      message: this.#errors.get(id) || t("error.dialog.unknown"),
    });
  }

  /**
   * Open the error/warning HISTORY for a tunnel (fired by clicking its Errors
   * card). The log is fetched on demand from main so the stats heartbeat stays
   * lean; a failed/empty fetch just yields an empty history.
   */
  async #showErrorHistory(id) {
    const def = this.#defs.find((d) => d.id === id);
    let events = [];
    try {
      const res = await this.#porthippo?.tunnels?.events?.(id);
      if (Array.isArray(res)) events = res;
    } catch {
      events = [];
    }
    const element = buildErrorHistory({
      events,
      title: t("errors.dialog.title", {
        name: (def && def.name) || t("def.unnamed"),
      }),
      now: this.#now,
      onClose: () => PopupManager.close(),
    });
    PopupManager.open({ element, onMaskClick: () => PopupManager.close() });
  }

  #setLiveState(id, state) {
    this.#states.set(id, state);
    this.#list.updateState(id, state);
    this.#table.updateState(id, state);
    if (id === this.#selectedId) this.#detail.updateState(state);
  }

  #persistCardOrder(order) {
    this.#cardOrder = order;
    this.#detail.setCardOrder(order);
    this.#table.setCardOrder(order);
    this.#porthippo?.settings?.set?.({ cardOrder: order })?.catch?.(() => {});
  }

  /** Persist the shared card layout ({col,row} map) that every tunnel uses — the
   *  detail canvas reports it as the user drags / adds / removes a card. */
  #persistCardLayout(positions) {
    this.#cardLayout = positions;
    this.#porthippo?.settings
      ?.set?.({ cardLayout: positions })
      ?.catch?.(() => {});
  }

  /**
   * Resolve the one shared card layout from settings. Prefers the new `cardLayout`
   * (a single {col,row} map used by every tunnel). If only the legacy per-tunnel
   * `cardLayouts` map is stored, migrate it by adopting the FIRST tunnel's layout
   * — in tunnel-list order, falling back to the first stored entry — as the shared
   * one, then persist that and drop the legacy key (a patch value of `undefined`
   * is omitted by JSON.stringify on write). Returns the layout, or null when
   * nothing is stored (first run).
   */
  #loadCardLayout(settings) {
    const isLayout = (v) =>
      Boolean(v) && typeof v === "object" && !Array.isArray(v);
    if (isLayout(settings?.cardLayout)) return settings.cardLayout;

    const legacy = settings?.cardLayouts;
    if (!isLayout(legacy)) return null;

    let migrated = null;
    for (const def of this.#defs) {
      if (def && isLayout(legacy[def.id])) {
        migrated = legacy[def.id];
        break;
      }
    }
    if (!migrated) migrated = Object.values(legacy).find(isLayout) || null;

    this.#porthippo?.settings
      ?.set?.({ cardLayout: migrated, cardLayouts: undefined })
      ?.catch?.(() => {});
    return migrated;
  }

  #persistListSort(sort) {
    this.#porthippo?.settings?.set?.({ listSort: sort })?.catch?.(() => {});
  }

  #persistSplit(px) {
    this.#porthippo?.settings
      ?.set?.({ splitLeft: Math.round(px) })
      ?.catch?.(() => {});
  }

  // ── Groups (Feature 140) ──────────────────────────────────────────────────

  /** Push the current grouping context into both list views. */
  #pushGrouping() {
    const ctx = {
      groups: this.#groups,
      collapsedIds: this.#collapsed,
    };
    this.#list.setGrouping(ctx);
    this.#table.setGrouping(ctx);
  }

  // ── Collapse / group actions ──────────────────────────────────────────────

  #toggleCollapse(sectionId) {
    if (this.#collapsed.has(sectionId)) this.#collapsed.delete(sectionId);
    else this.#collapsed.add(sectionId);
    this.#pushGrouping();
    this.#persistCollapsed();
  }

  #persistCollapsed() {
    // Persist the whole map (the settings store shallow-merges, so a partial write
    // would replace — not merge — the key).
    const map = {};
    for (const id of this.#collapsed) map[id] = true;
    this.#porthippo?.settings
      ?.set?.({ groupCollapsed: map })
      ?.catch?.(() => {});
  }

  /** The ids of the tunnels in a section (UNGROUPED = ungrouped / dangling). */
  #idsInSection(sectionId) {
    const known = new Set(this.#groups.map((g) => g.id));
    if (sectionId === UNGROUPED_ID) {
      return this.#defs
        .filter((d) => !d.groupId || !known.has(d.groupId))
        .map((d) => d.id);
    }
    return this.#defs.filter((d) => d.groupId === sectionId).map((d) => d.id);
  }

  #groupAction(sectionId, action) {
    const ids = this.#idsInSection(sectionId);
    if (ids.length === 0) return;
    this.#porthippo?.tunnels?.applyMany?.(ids, action)?.catch?.(() => {});
  }

  async #showGroupMenu(sectionId) {
    const isUngrouped = sectionId === UNGROUPED_ID;
    const items = [
      { id: "arm", label: t("group.menu.armAll") },
      { id: "disarm", label: t("group.menu.disarmAll") },
      { id: "pause", label: t("group.menu.pauseAll") },
      { id: "resume", label: t("group.menu.resumeAll") },
    ];
    if (!isUngrouped) {
      items.push(
        { type: "separator" },
        { id: "edit", label: t("group.menu.edit") },
        { id: "delete", label: t("group.menu.delete") },
      );
    }
    const action = await this.#porthippo?.contextMenu?.popup?.({ items });
    switch (action) {
      case "arm":
      case "disarm":
      case "pause":
      case "resume":
        this.#groupAction(sectionId, action);
        break;
      case "edit":
        this.#editGroup(sectionId);
        break;
      case "delete":
        this.#confirmDeleteGroup(sectionId);
        break;
      default:
        break;
    }
  }

  // ── Group CRUD + membership ───────────────────────────────────────────────

  #newGroup(assignIds) {
    this.#pendingAssignIds = Array.isArray(assignIds) ? assignIds : null;
    this.#groupEditor.openCreate();
  }

  #editGroup(groupId) {
    const group = this.#groups.find((g) => g.id === groupId);
    if (group) this.#groupEditor.openEdit(group);
  }

  #confirmDeleteGroup(groupId) {
    const group = this.#groups.find((g) => g.id === groupId);
    if (!group) return;
    PopupManager.confirmDelete({
      message: t("group.delete.message", { name: group.label }),
      onConfirm: async () => {
        const result = await this.#porthippo?.groups?.delete?.(groupId);
        if (result && result.__hippoError) {
          PopupManager.notify({ message: result.message || "Delete failed" });
          return;
        }
        await this.load();
      },
    });
  }

  async #afterGroupSaved(record) {
    // If this group was created to receive a pending selection, move those tunnels
    // into it now; #assignMany reloads. Otherwise the porthippo:groups-changed
    // listener reloads both views.
    if (this.#pendingAssignIds && record && record.id) {
      const ids = this.#pendingAssignIds;
      this.#pendingAssignIds = null;
      await this.#assignMany(ids, record.id);
    } else {
      this.#pendingAssignIds = null;
    }
  }

  /** Move a set of tunnels into a group (or to Ungrouped when groupId is null). */
  async #assignMany(ids, groupId) {
    const writes = [];
    for (const id of ids) {
      const def = this.#defs.find((d) => d.id === id);
      if (!def) continue;
      writes.push(
        this.#porthippo?.tunnels?.update?.(
          id,
          this.#assignPayload(def, groupId),
        ),
      );
    }
    try {
      await Promise.all(writes);
    } catch {
      // best-effort; a failed assignment just leaves that tunnel where it was
    }
    window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
    await this.load();
  }

  /**
   * Move a tunnel into a group AND sequence it there (cards/treeview drag): rebuild
   * the global display order with the dragged tunnel re-inserted before `beforeId`
   * (or appended to the target group when `beforeId` is null), flip its group
   * membership if it changed, and persist. `groupId` null → Ungrouped.
   */
  async #moveTunnel(id, groupId, beforeId) {
    const def = this.#defs.find((d) => d.id === id);
    if (!def) return;
    const groupOf = (d) =>
      d.groupId && this.#groups.some((g) => g.id === d.groupId)
        ? d.groupId
        : null;
    const target =
      groupId && this.#groups.some((g) => g.id === groupId) ? groupId : null;
    const currentGroupId = groupOf(def);

    // New global order: current order minus the dragged id, re-inserted at the slot.
    const order = this.#defs.map((d) => d.id).filter((x) => x !== id);
    let idx;
    if (beforeId != null && order.includes(beforeId)) {
      idx = order.indexOf(beforeId);
    } else {
      // Append after the target group's last remaining member (or at the very end
      // when the group has no other visible members).
      const members = this.#defs.filter(
        (d) => d.id !== id && groupOf(d) === target,
      );
      idx = members.length
        ? order.indexOf(members[members.length - 1].id) + 1
        : order.length;
    }
    order.splice(idx, 0, id);

    const sameOrder =
      order.length === this.#defs.length &&
      order.every((x, i) => x === this.#defs[i].id);
    if (currentGroupId === target && sameOrder) return; // nothing changed

    if (currentGroupId !== target) {
      const res = await this.#porthippo?.tunnels?.update?.(
        id,
        this.#assignPayload(def, target),
      );
      if (res && res.__hippoError) {
        PopupManager.notify({ message: res.message || "Engine error" });
        return;
      }
    }
    await this.#porthippo?.tunnels?.reorder?.(order);
    window.dispatchEvent(new CustomEvent("porthippo:tunnels-changed"));
    await this.load();
  }

  /** A full-definition update payload that only changes group membership. */
  #assignPayload(def, groupId) {
    const payload = { ...def };
    delete payload.order; // derived
    delete payload.routeSummary; // derived
    delete payload.group; // derived
    if (groupId) payload.groupId = groupId;
    else delete payload.groupId; // omit → the store drops it (ungrouped)
    return payload;
  }

  async #reorderGroups(fromId, toId) {
    const ids = this.#groups.map((g) => g.id);
    const from = ids.indexOf(fromId);
    if (from === -1 || fromId === toId) return;
    ids.splice(from, 1);
    const at = ids.indexOf(toId);
    ids.splice(at === -1 ? ids.length : at, 0, fromId);
    const result = await this.#porthippo?.groups?.reorder?.(ids);
    if (result && result.__hippoError) return;
    await this.load();
  }

  #assignMenuItems(currentGroupId) {
    const items = this.#groups.map((g) => ({
      id: `assign:${g.id}`,
      label: g.label,
      enabled: g.id !== currentGroupId,
    }));
    items.push({
      id: `assign:${UNGROUPED_ID}`,
      label: t("group.ungrouped"),
      enabled: Boolean(currentGroupId),
    });
    items.push({ type: "separator" });
    items.push({ id: "assign:__new", label: t("group.newEllipsis") });
    return items;
  }

  #handleAssignChoice(choice, ids) {
    if (typeof choice !== "string" || !choice.startsWith("assign:")) return;
    const target = choice.slice("assign:".length);
    if (target === "__new") {
      this.#newGroup(ids);
      return;
    }
    this.#assignMany(ids, target === UNGROUPED_ID ? null : target);
  }
}
