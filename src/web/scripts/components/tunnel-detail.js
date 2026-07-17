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

// tunnel-detail.js — the detail panel for the selected tunnel. Its title is a
// virtual breadcrumb of the route (local → jump hosts → SSH server → target) with
// arm/disarm + pause/resume icon controls on the right; below it is a snap-to-grid
// infinite canvas of stat cards (card-canvas.js). It is a pure view: numbers
// arrive via updateSnap(), state via updateState(), and every action is reported
// back through constructor callbacks. Which cards are visible is fed in / reported
// out (the `cardOrder` setting, shared with the list view via card-catalog.js);
// *where* each card sits is one {col,row} layout the canvas owns and reports
// through onLayoutChange — a single layout the owner persists for every tunnel.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import {
  getCard,
  DEFAULT_CARD_ORDER,
  visibleCards,
  cardToneClasses,
} from "./card-catalog.js";
import { CardMenu } from "./card-menu.js";
import { CardCanvas } from "./card-canvas.js";
import { typeIcon } from "./tunnel-list.js";
import { newScheduleBadge, renderScheduleBadge } from "./schedule-badge.js";

/** Armed = the engine holds this tunnel (anything but disarmed / error). */
function isArmed(state) {
  return Boolean(state) && state !== "disarmed" && state !== "error";
}

export class TunnelDetail {
  #el;
  #emptyEl;
  #contentEl;
  #breadcrumbEl;
  #armBtn;
  #pauseBtn;
  #cardsEmptyEl;
  #canvas;
  #cardMenu;

  #def = null;
  #state = "disarmed";
  #snap = null;
  #schedBadge = null; // the breadcrumb's schedule badge (Feature 150)
  #jumpsById = new Map();
  #visible = [...DEFAULT_CARD_ORDER]; // ordered VISIBLE card keys
  #layout = null; // this tunnel's stored {col,row} map (from show())
  #cardNodes = new Map(); // key → { root, valueEl, card }

  #now;
  #onToggleArm;
  #onTogglePause;
  #onCardsChange;
  #onLayoutChange;
  #onShowError;
  #onShowErrors;

  constructor({
    now,
    onToggleArm,
    onTogglePause,
    onCardsChange,
    onLayoutChange,
    onShowError,
    onShowErrors,
  } = {}) {
    this.#now = now || Date.now;
    this.#onToggleArm = onToggleArm || (() => {});
    this.#onTogglePause = onTogglePause || (() => {});
    this.#onCardsChange = onCardsChange || (() => {});
    this.#onLayoutChange = onLayoutChange || (() => {});
    this.#onShowError = onShowError || (() => {});
    this.#onShowErrors = onShowErrors || (() => {});
    this.#cardMenu = new CardMenu({
      visible: () => this.#visible,
      onToggle: (key, show) => this.#toggleCard(key, show),
    });
    this.#canvas = new CardCanvas({
      onLayoutChange: (positions) =>
        this.#def && this.#onLayoutChange(positions),
      // Dragging a card over the Data Fields selector arms it as a trash target;
      // dropping there removes the card and deselects the field.
      onDeleteHover: (active) => this.#cardMenu.setDeleteTarget(active),
      onDelete: (key) => this.#toggleCard(key, false),
    });
    // The selector lives in the title row, outside the canvas — hand the canvas
    // its element so a drag can hit-test the pointer against it.
    this.#canvas.setDeleteZone(this.#cardMenu.element);
    this.#el = this.#build();
  }

  get element() {
    return this.#el;
  }

  #build() {
    this.#emptyEl = el("div", { class: "detail-empty" }, [
      el("p", { class: "detail-empty-hint", text: t("tunnels.selectHint") }),
    ]);

    this.#breadcrumbEl = el("div", {
      class: "detail-route",
      "aria-label": t("detail.route.target"),
    });

    // Arm/disarm is a checkbox styled as a slider switch (see .detail-arm-switch):
    // checked = armed (green track), unchecked = disarmed (red track).
    this.#armBtn = el("input", {
      class: "detail-arm-switch",
      type: "checkbox",
      role: "switch",
      onChange: () => this.#def && this.#onToggleArm(this.#def.id),
    });
    this.#pauseBtn = el("button", {
      class: "btn--icon detail-ctrl detail-pause-btn",
      type: "button",
      html: icons.pause(),
      onClick: () => this.#def && this.#onTogglePause(this.#def.id),
    });

    this.#cardsEmptyEl = el("p", {
      class: "detail-cards-empty",
      text: t("detail.cards.empty"),
      hidden: true,
    });

    this.#contentEl = el("div", { class: "detail-content", hidden: true }, [
      el("div", { class: "detail-title" }, [
        this.#breadcrumbEl,
        el("div", { class: "detail-controls" }, [
          this.#cardMenu.element,
          this.#pauseBtn,
          this.#armBtn,
        ]),
      ]),
      this.#canvas.element,
      this.#cardsEmptyEl,
    ]);

    return el(
      "section",
      { class: "tunnel-detail", "aria-label": t("tunnels.title") },
      [this.#emptyEl, this.#contentEl],
    );
  }

  /** Adopt the persisted set of visible cards, in order (re-renders if shown). */
  setCardOrder(order) {
    this.#visible = visibleCards(order);
    this.#cardMenu.sync(this.#visible);
    if (this.#def) this.#renderCards();
  }

  /** Show a tunnel's details. `ctx` carries the live state, latest snapshot, a
   *  jumpHost-by-id map for the breadcrumb, and the shared card layout ({col,row}
   *  per card, common to every tunnel) for the canvas to restore. */
  show(
    def,
    { state = "disarmed", snap = null, jumpsById, layout = null } = {},
  ) {
    this.#def = def || null;
    this.#state = state;
    this.#snap = snap;
    this.#layout = layout;
    if (jumpsById instanceof Map) this.#jumpsById = jumpsById;
    this.#renderAll();
  }

  /** No tunnel selected → the empty hint. */
  clear() {
    this.#def = null;
    this.#renderAll();
  }

  /** Fold in a fresh snapshot (+ optional state) and update values in place. */
  updateSnap(snap, state) {
    this.#snap = snap;
    if (state) this.#state = state;
    if (!this.#def) return;
    this.#updateValues();
    this.#updateControls();
  }

  /** A discrete state change: refresh the controls + the State card. */
  updateState(state) {
    this.#state = state;
    if (!this.#def) return;
    this.#updateControls();
    this.#updateValues();
  }

  /** Refresh the breadcrumb's schedule badge from the store (Feature 150). */
  applySchedule() {
    if (this.#schedBadge && this.#def) {
      renderScheduleBadge(this.#schedBadge, this.#def.id);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  #renderAll() {
    const has = Boolean(this.#def);
    this.#emptyEl.hidden = has;
    this.#contentEl.hidden = !has;
    if (!has) return;
    this.#renderBreadcrumb();
    this.#renderCards();
    this.#updateControls();
  }

  #routeSegments() {
    const d = this.#def || {};
    const type = d.type || "local";
    const jumpSegs = (d.jumpHostIds || []).map((id) => {
      const jh = this.#jumpsById.get(id);
      return jh ? jh.label || `${jh.host}:${jh.port}` : id;
    });
    const server =
      typeof d.sshHost === "string" && d.sshHost.trim() !== ""
        ? `${d.sshHost}:${d.sshPort ?? 22}`
        : null;

    if (type === "dynamic") {
      // Local SOCKS listener → chain → the SSH server (the exit vantage).
      const segs = [
        `${d.bindHost || "127.0.0.1"}:${d.localPort ?? "?"}`,
        ...jumpSegs,
      ];
      if (server) segs.push(server);
      return segs;
    }
    if (type === "remote") {
      // The port bound on the server → chain → the local target it forwards to.
      const bind = d.remoteBind || {};
      return [
        `${d.sshHost ?? "?"}:${bind.port ?? "?"}`,
        ...jumpSegs,
        `${d.destination?.host ?? "127.0.0.1"}:${d.destination?.port ?? "?"}`,
      ];
    }
    // local: local listener → chain → [bastion] → destination.
    const segs = [
      `${d.bindHost || "127.0.0.1"}:${d.localPort ?? "?"}`,
      ...jumpSegs,
    ];
    if (server) segs.push(server);
    segs.push(`${d.destination?.host ?? "?"}:${d.destination?.port ?? "?"}`);
    return segs;
  }

  #renderBreadcrumb() {
    clear(this.#breadcrumbEl);
    this.#breadcrumbEl.appendChild(typeIcon(this.#def));
    // Feature 150: badge a scheduled tunnel with its next transition.
    this.#schedBadge = newScheduleBadge(this.#def?.id);
    this.#breadcrumbEl.appendChild(this.#schedBadge);
    const segs = this.#routeSegments();
    segs.forEach((seg, i) => {
      if (i > 0) {
        this.#breadcrumbEl.appendChild(
          el("span", { class: "route-sep", "aria-hidden": "true", text: "›" }),
        );
      }
      const last = i === segs.length - 1;
      this.#breadcrumbEl.appendChild(
        el("span", {
          class: `route-seg${last ? " route-seg--target" : ""}${i === 0 ? " route-seg--local" : ""}`,
          text: seg,
        }),
      );
    });
  }

  #renderCards() {
    this.#cardNodes.clear();
    const empty = this.#visible.length === 0;
    this.#cardsEmptyEl.hidden = !empty;
    this.#canvas.element.hidden = empty;

    const entries = [];
    for (const key of empty ? [] : this.#visible) {
      const card = getCard(key);
      if (!card) continue;
      entries.push({ key, node: this.#buildCard(key, card) });
    }
    // The canvas owns positioning: it keeps this tunnel's live layout across a
    // visible-set change and adopts the stored one when the tunnel switches.
    this.#canvas.setCards(this.#def?.id ?? null, entries, this.#layout);
    this.#updateValues();
  }

  #buildCard(key, card) {
    const valueEl = el("div", { class: "card-value" });
    const props = {
      class: "detail-card",
      role: "listitem",
      dataset: { card: key },
    };
    // Two cards double as buttons: the State card opens the current error while
    // errored; the Errors card opens the whole error history when the count is
    // non-zero (see #updateCardAffordances for the matching cue). The canvas
    // distinguishes a click from a drag, so these coexist with dragging.
    if (key === "state" || key === "errors") {
      props.onClick = () => this.#activateCard(key);
      props.onKeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this.#activateCard(key);
        }
      };
    }
    const root = el("div", props, [
      el("div", { class: "card-label", text: t(card.labelKey) }),
      valueEl,
    ]);
    this.#cardNodes.set(key, { root, valueEl, card });
    return root;
  }

  #updateValues() {
    const ctx = { snap: this.#snap, now: this.#now(), state: this.#state };
    for (const [, rec] of this.#cardNodes) {
      rec.valueEl.textContent = rec.card.value(ctx);
      rec.valueEl.className = "card-value";
      for (const cls of cardToneClasses(rec.card, ctx)) {
        rec.valueEl.classList.add(cls);
      }
    }
    this.#updateCardAffordances();
  }

  /**
   * Toggle the "click me" affordance on the two activatable cards: the State card
   * (danger-tinted) while the tunnel is errored, and the Errors card while its
   * count is non-zero. Any other time they're inert display cards like the rest.
   */
  #updateCardAffordances() {
    this.#setCardActivatable(
      "state",
      this.#state === "error",
      "detail-card--error",
      "error.card.hint",
    );
    this.#setCardActivatable(
      "errors",
      (this.#snap?.errorCount ?? 0) > 0,
      "detail-card--clickable",
      "errors.card.hint",
    );
  }

  #setCardActivatable(key, active, cls, hintKey) {
    const rec = this.#cardNodes.get(key);
    if (!rec) return;
    rec.root.classList.toggle(cls, active);
    if (active) {
      rec.root.setAttribute("role", "button");
      rec.root.setAttribute("tabindex", "0");
      rec.root.title = t(hintKey);
      rec.root.setAttribute("aria-label", t(hintKey));
    } else {
      rec.root.setAttribute("role", "listitem");
      rec.root.removeAttribute("tabindex");
      rec.root.removeAttribute("title");
      rec.root.removeAttribute("aria-label");
    }
  }

  /** Activate an error card: State → the current error; Errors → the history. */
  #activateCard(key) {
    if (!this.#def) return;
    if (key === "state" && this.#state === "error") {
      this.#onShowError(this.#def.id);
    } else if (key === "errors" && (this.#snap?.errorCount ?? 0) > 0) {
      this.#onShowErrors(this.#def.id);
    }
  }

  #updateControls() {
    const armed = isArmed(this.#state);
    this.#armBtn.checked = armed;
    const armLabel = armed ? t("detail.disarm") : t("detail.arm");
    this.#armBtn.title = armLabel;
    this.#armBtn.setAttribute("aria-label", armLabel);

    const paused = this.#state === "paused";
    const canPause = this.#state === "connected" || paused;
    this.#pauseBtn.innerHTML = paused ? icons.play() : icons.pause();
    const pauseLabel = paused ? t("detail.resume") : t("detail.pause");
    this.#pauseBtn.title = pauseLabel;
    this.#pauseBtn.setAttribute("aria-label", pauseLabel);
    this.#pauseBtn.disabled = !canPause;
  }

  // ── Manage cards (the checklist menu — add + remove) ──────────────────────

  /** Show/hide a card. Used by the checklist menu (appends when re-shown) and by
   *  the canvas's drag-to-Data-Fields removal — so keep the menu's checkboxes in
   *  step for either path. */
  #toggleCard(key, show) {
    const shown = this.#visible.includes(key);
    if (show === shown) return;
    this.#visible = show
      ? [...this.#visible, key]
      : this.#visible.filter((k) => k !== key);
    this.#cardMenu.sync(this.#visible);
    this.#renderCards();
    this.#onCardsChange([...this.#visible]);
  }
}
