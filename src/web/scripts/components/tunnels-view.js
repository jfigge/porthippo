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
import { TunnelList } from "./tunnel-list.js";
import { TunnelDetail } from "./tunnel-detail.js";
import { TunnelTable } from "./tunnel-table.js";
import { SplitResizer } from "./split-resizer.js";
import { buildErrorHistory } from "./error-history-dialog.js";

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

  #onStats;
  #onTunnelState;
  #onSetMode;

  constructor({ porthippo, openKeyFile, now } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#now = now || Date.now;

    this.#editor = new TunnelEditorDialog({
      porthippo: this.#porthippo,
      openKeyFile,
      onSubmit: (payload, ctx) => this.#submit(payload, ctx),
      onSaved: (record) => this.#afterSaved(record),
    });

    this.#list = new TunnelList({
      onSelect: (id) => this.#select(id),
      onAdd: () => this.#editor.openCreate(),
      onEdit: (id) => this.#editById(id),
      // Delete is offered from the sidebar row's right-click menu, not an icon.
      onContextMenu: (id) => this.#showContextMenu(id),
    });

    this.#detail = new TunnelDetail({
      now: this.#now,
      onToggleArm: (id) => this.#toggleArm(id),
      onTogglePause: (id) => this.#togglePause(id),
      onCardsChange: (order) => this.#persistCardOrder(order),
      onShowError: (id) => this.#showError(id),
      onShowErrors: (id) => this.#showErrorHistory(id),
    });

    this.#table = new TunnelTable({
      now: this.#now,
      onSelect: (id) => this.#select(id),
      onAdd: () => this.#editor.openCreate(),
      onEdit: (id) => this.#editById(id),
      onDelete: (id) => this.#confirmDelete(id),
      onCardsChange: (order) => this.#persistCardOrder(order),
      onSortChange: (sort) => this.#persistListSort(sort),
      onToggleArm: (id) => this.#toggleArm(id),
      onTogglePause: (id) => this.#togglePause(id),
      onContextMenu: (id) => this.#showContextMenu(id),
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
    // The view-mode toggle lives in the app header; it broadcasts the intent
    // and we echo the resolved mode back so the toggle's glyph/hint stays in sync.
    this.#onSetMode = (e) => this.#setMode(e.detail && e.detail.mode);
    window.addEventListener("porthippo:stats-updated", this.#onStats);
    window.addEventListener("porthippo:tunnel-state", this.#onTunnelState);
    window.addEventListener("porthippo:set-detail-mode", this.#onSetMode);
  }

  get element() {
    return this.#el;
  }

  /** Load definitions, jump hosts (breadcrumb), live state, card order + mode. */
  async load() {
    const [defs, status, jumps, settings] = await Promise.all([
      this.#porthippo?.tunnels?.list?.() ?? [],
      this.#porthippo?.tunnels?.status?.() ?? [],
      this.#porthippo?.jumpHosts?.list?.() ?? [],
      this.#porthippo?.settings?.get?.() ?? {},
    ]);
    this.#defs = Array.isArray(defs) ? defs : [];
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
      this.#jumpsById,
    );
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
        break; // dismissed (null) or an unknown id
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

  #persistListSort(sort) {
    this.#porthippo?.settings?.set?.({ listSort: sort })?.catch?.(() => {});
  }

  #persistSplit(px) {
    this.#porthippo?.settings
      ?.set?.({ splitLeft: Math.round(px) })
      ?.catch?.(() => {});
  }
}
