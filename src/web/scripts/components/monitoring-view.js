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

// monitoring-view.js — the Monitoring pane: a live, throttled dashboard of every
// tunnel. It is a PURE SUBSCRIBER — it never computes stats. Numbers arrive from
// Feature 30's stats-store over `porthippo:stats-updated` (a Map id→snapshot);
// definition names/order come from `tunnels.list()`; state changes arrive over
// `porthippo:tunnel-state` (seeded once from `tunnels.status()`). Rows are updated
// in place on each ~1 Hz snapshot (no full-list rebuild); rows are added/removed
// only when the visible set changes. An All/Active header toggle filters the list
// and persists via settings. Every action goes through `window.porthippo.*`.

import { el } from "../dom.js";
import { t } from "../strings.js";
import { PopupManager } from "../popup-manager.js";
import {
  formatRate,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from "../utils/format.js";

/** Armed = the engine holds this tunnel (anything but disarmed / error). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

/** Active = actually doing something: connected or explicitly paused. */
function isActive(state) {
  return state === "connected" || state === "paused";
}

const FILTERS = ["all", "active"];

export class MonitoringView {
  #el;
  #listEl;
  #emptyEl;
  #filterBtns = new Map(); // filter name → button element
  #porthippo;
  #now;

  #defs = [];
  #states = new Map(); // id → latest state string
  #errors = new Map(); // id → latest error message
  #snaps = new Map(); // id → latest stats snapshot (from stats-store)
  #rows = new Map(); // id → { root, ...cached child nodes }
  #filter = "all";

  #onStats;
  #onTunnelState;
  #onTunnelsChanged;

  /**
   * @param {object} [opts]
   * @param {object} [opts.porthippo]  the IPC bridge (defaults to window.porthippo)
   * @param {() => number} [opts.now]  injected clock (ms epoch) for relative times
   */
  constructor({ porthippo, now } = {}) {
    this.#porthippo = porthippo || window.porthippo;
    this.#now = now || Date.now;
    this.#el = this.#build();

    // Numbers come from the stats-store's derived event (a Map id→snapshot); state
    // comes from the engine's broadcast; the visible set follows the definition list.
    this.#onStats = (event) => this.#applyStats(event.detail);
    this.#onTunnelState = (event) => this.#applyState(event.detail);
    this.#onTunnelsChanged = () => this.#reload();
    window.addEventListener("porthippo:stats-updated", this.#onStats);
    window.addEventListener("porthippo:tunnel-state", this.#onTunnelState);
    window.addEventListener(
      "porthippo:tunnels-changed",
      this.#onTunnelsChanged,
    );
  }

  get element() {
    return this.#el;
  }

  /** Load definitions, seed live state + the persisted filter. Call once after mount. */
  async load() {
    const [defs, status, settings] = await Promise.all([
      this.#porthippo?.tunnels?.list?.() ?? [],
      this.#porthippo?.tunnels?.status?.() ?? [],
      this.#porthippo?.settings?.get?.() ?? {},
    ]);
    this.#defs = Array.isArray(defs) ? defs : [];
    if (Array.isArray(status)) {
      for (const s of status) {
        if (s && s.id) this.#states.set(s.id, s.state);
      }
    }
    if (settings && FILTERS.includes(settings.monitorFilter)) {
      this.#filter = settings.monitorFilter;
    }
    this.#syncFilterButtons();
    this.#render();
  }

  destroy() {
    window.removeEventListener("porthippo:stats-updated", this.#onStats);
    window.removeEventListener("porthippo:tunnel-state", this.#onTunnelState);
    window.removeEventListener(
      "porthippo:tunnels-changed",
      this.#onTunnelsChanged,
    );
  }

  // ── Shell ───────────────────────────────────────────────────────────────

  #build() {
    this.#listEl = el("div", { class: "mon-list", role: "list" });
    this.#emptyEl = el("div", { class: "mon-empty" }, [
      el("p", { class: "mon-empty-text" }),
    ]);

    const filter = el(
      "div",
      { class: "mon-filter", role: "tablist", "aria-label": t("mon.title") },
      FILTERS.map((name) => {
        const btn = el("button", {
          class: "mon-filter-btn",
          type: "button",
          role: "tab",
          text: t(`mon.filter.${name}`),
          title: t(`mon.filter.${name}.title`),
          dataset: { filter: name },
          onClick: () => this.#setFilter(name),
        });
        this.#filterBtns.set(name, btn);
        return btn;
      }),
    );

    return el("div", { class: "monitoring-view" }, [
      el("div", { class: "mon-header" }, [
        el("span", { class: "mon-title", text: t("mon.title") }),
        filter,
      ]),
      this.#emptyEl,
      this.#listEl,
    ]);
  }

  // ── Filter ────────────────────────────────────────────────────────────────

  #setFilter(name) {
    if (!FILTERS.includes(name) || name === this.#filter) return;
    this.#filter = name;
    this.#syncFilterButtons();
    this.#render();
    // Persist the choice; non-fatal if the write fails.
    this.#porthippo?.settings
      ?.set?.({ monitorFilter: name })
      ?.catch?.(() => {});
  }

  #syncFilterButtons() {
    for (const [name, btn] of this.#filterBtns) {
      const active = name === this.#filter;
      btn.classList.toggle("mon-filter-btn--active", active);
      btn.setAttribute("aria-selected", String(active));
    }
  }

  // ── Live data ───────────────────────────────────────────────────────────

  #applyStats(detail) {
    const stats = detail && detail.stats;
    this.#snaps = stats instanceof Map ? stats : new Map();
    // A heartbeat also carries the current state; fold it in so the badge stays
    // fresh even if a discrete tunnel-state broadcast was missed.
    for (const snap of this.#snaps.values()) {
      if (!snap || !snap.id) continue;
      this.#states.set(snap.id, snap.state);
      if (snap.error) this.#errors.set(snap.id, snap.error);
      else this.#errors.delete(snap.id);
    }
    this.#render();
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
    }
    this.#render();
  }

  async #reload() {
    const defs = await (this.#porthippo?.tunnels?.list?.() ?? []);
    this.#defs = Array.isArray(defs) ? defs : [];
    this.#render();
  }

  #stateOf(id) {
    return this.#states.get(id) || "disarmed";
  }

  // ── Rendering (rows updated in place; add/remove only on set change) ──────

  #render() {
    const visible = this.#defs.filter((d) => this.#passesFilter(d.id));

    // Empty states: no definitions at all vs. an active filter with nothing active.
    const empty = visible.length === 0;
    this.#emptyEl.hidden = !empty;
    this.#listEl.hidden = empty;
    if (empty) {
      this.#emptyEl.querySelector(".mon-empty-text").textContent =
        this.#defs.length === 0 ? t("mon.empty") : t("mon.empty.active");
    }

    // Drop rows whose tunnel is no longer visible.
    const visibleIds = new Set(visible.map((d) => d.id));
    for (const [id, rec] of this.#rows) {
      if (!visibleIds.has(id)) {
        rec.root.remove();
        this.#rows.delete(id);
      }
    }

    // Add / update / order the visible rows. insertBefore only moves a node when
    // it isn't already in the right slot, so an unchanged list doesn't thrash.
    visible.forEach((def, i) => {
      let rec = this.#rows.get(def.id);
      if (!rec) {
        rec = this.#buildRow(def);
        this.#rows.set(def.id, rec);
      }
      this.#updateRow(rec, def);
      const atI = this.#listEl.children[i];
      if (atI !== rec.root) this.#listEl.insertBefore(rec.root, atI || null);
    });
  }

  #passesFilter(id) {
    if (this.#filter === "active") return isActive(this.#stateOf(id));
    return true;
  }

  #buildRow(def) {
    const badge = el("span", { class: "def-badge" });
    const name = el("span", { class: "mon-row-name" });
    const summary = el("span", { class: "mon-row-summary" });
    const rateUp = el("span", {
      class: "mon-rate mon-rate-up",
      title: t("mon.rateUp.title"),
    });
    const rateDown = el("span", {
      class: "mon-rate mon-rate-down",
      title: t("mon.rateDown.title"),
    });
    const total = el("span", {
      class: "mon-metric mon-total",
      title: t("mon.total.title"),
    });
    const conns = el("span", {
      class: "mon-metric mon-conns",
      title: t("mon.conns.title"),
    });
    const open = el("span", {
      class: "mon-metric mon-open",
      title: t("mon.open.title"),
    });
    const last = el("span", {
      class: "mon-metric mon-last",
      title: t("mon.last.title"),
    });

    const pauseBtn = el("button", {
      class: "btn btn--secondary mon-pause-btn",
      type: "button",
      onClick: () => this.#togglePause(def.id),
    });
    const armBtn = el("button", {
      class: "btn btn--secondary mon-arm-btn",
      type: "button",
      onClick: () => this.#toggleArm(def.id),
    });
    const editBtn = el("button", {
      class: "btn btn--ghost mon-edit-btn",
      type: "button",
      text: t("mon.edit"),
      title: t("mon.edit.title"),
      onClick: () => this.#edit(def.id),
    });

    const root = el("div", { class: "mon-row", role: "listitem" }, [
      badge,
      el("div", { class: "mon-row-main" }, [name, summary]),
      el("div", { class: "mon-row-rates" }, [rateUp, rateDown]),
      el("div", { class: "mon-row-metrics" }, [total, conns, open, last]),
      el("div", { class: "mon-row-controls" }, [pauseBtn, armBtn, editBtn]),
    ]);

    return {
      root,
      badge,
      name,
      summary,
      rateUp,
      rateDown,
      total,
      conns,
      open,
      last,
      pauseBtn,
      armBtn,
      editBtn,
    };
  }

  #updateRow(rec, def) {
    const state = this.#stateOf(def.id);
    const snap = this.#snaps.get(def.id) || null;
    const now = this.#now();

    rec.badge.className = `def-badge def-badge--${state}`;
    rec.badge.textContent = t(`state.${state}`);
    rec.badge.title = state === "error" ? this.#errors.get(def.id) || "" : "";

    rec.name.textContent = def.name || t("def.unnamed");
    rec.summary.textContent = t("def.list.summary", {
      localPort: def.localPort ?? "?",
      host: def.destination?.host ?? "?",
      port: def.destination?.port ?? "?",
    });

    rec.rateUp.textContent = t("mon.rateUp", {
      rate: formatRate(snap?.rateUp ?? 0),
    });
    rec.rateDown.textContent = t("mon.rateDown", {
      rate: formatRate(snap?.rateDown ?? 0),
    });
    rec.total.textContent = t("mon.total", {
      total: formatBytes(snap?.totalBytes ?? 0),
    });
    rec.conns.textContent = t("mon.conns", { n: snap?.activeConnections ?? 0 });
    rec.open.textContent = snap?.openedAt
      ? t("mon.open", { duration: formatDuration(now - snap.openedAt) })
      : t("mon.open.none");
    rec.last.textContent = snap?.lastActiveAt
      ? t("mon.last", { when: formatRelativeTime(snap.lastActiveAt, now) })
      : t("mon.open.none");

    // Arm / disarm reflects the live state.
    const armed = isArmed(state);
    rec.armBtn.textContent = armed ? t("mon.disarm") : t("mon.arm");
    rec.armBtn.title = rec.armBtn.textContent;
    rec.armBtn.classList.toggle("mon-arm-btn--armed", armed);

    // Pause / resume only makes sense once connected; disabled otherwise.
    const paused = state === "paused";
    const canPause = state === "connected" || paused;
    rec.pauseBtn.textContent = paused ? t("mon.resume") : t("mon.pause");
    rec.pauseBtn.title = rec.pauseBtn.textContent;
    rec.pauseBtn.disabled = !canPause;
  }

  // ── Controls (intents only — live state arrives via the broadcasts) ───────

  async #toggleArm(id) {
    const armed = isArmed(this.#stateOf(id));
    // Optimistic: reflect the intent immediately; the broadcast will correct it.
    this.#states.set(id, armed ? "disarmed" : "listening");
    this.#render();
    const result = await (armed
      ? this.#porthippo?.tunnels?.disarm?.(id)
      : this.#porthippo?.tunnels?.arm?.(id));
    this.#reportError(result);
  }

  async #togglePause(id) {
    const state = this.#stateOf(id);
    if (state !== "connected" && state !== "paused") return;
    const result = await (state === "paused"
      ? this.#porthippo?.tunnels?.resume?.(id)
      : this.#porthippo?.tunnels?.pause?.(id));
    this.#reportError(result);
  }

  #edit(id) {
    window.dispatchEvent(
      new CustomEvent("porthippo:edit-tunnel", { detail: { id } }),
    );
  }

  #reportError(result) {
    if (result && result.__hippoError) {
      PopupManager.notify({ message: result.message || "Engine error" });
    }
  }
}
