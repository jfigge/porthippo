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
// arm/disarm + pause/resume icon controls on the right; below it is a grid of
// drag-and-drop rearrangeable stat cards. It is a pure view: numbers arrive via
// updateSnap(), state via updateState(), and every action is reported back through
// constructor callbacks. Card order is fed in / reported out (persisted by the
// owner in settings) and shared with the list view via card-catalog.js.

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { icons } from "../icons.js";
import {
  getCard,
  DEFAULT_CARD_ORDER,
  visibleCards,
  reorderCards,
  cardToneClasses,
} from "./card-catalog.js";
import { CardMenu } from "./card-menu.js";

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
  #cardsEl;
  #cardMenu;

  #def = null;
  #state = "disarmed";
  #snap = null;
  #jumpsById = new Map();
  #visible = [...DEFAULT_CARD_ORDER]; // ordered VISIBLE card keys
  #cardNodes = new Map(); // key → { root, valueEl, card }
  #dragKey = null;

  #now;
  #onToggleArm;
  #onTogglePause;
  #onCardsChange;
  #onShowError;
  #onShowErrors;

  constructor({
    now,
    onToggleArm,
    onTogglePause,
    onCardsChange,
    onShowError,
    onShowErrors,
  } = {}) {
    this.#now = now || Date.now;
    this.#onToggleArm = onToggleArm || (() => {});
    this.#onTogglePause = onTogglePause || (() => {});
    this.#onCardsChange = onCardsChange || (() => {});
    this.#onShowError = onShowError || (() => {});
    this.#onShowErrors = onShowErrors || (() => {});
    this.#cardMenu = new CardMenu({
      visible: () => this.#visible,
      onToggle: (key, show) => this.#toggleCard(key, show),
    });
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

    this.#armBtn = el("button", {
      class: "btn--icon detail-ctrl detail-arm-btn",
      type: "button",
      html: icons.power(),
      onClick: () => this.#def && this.#onToggleArm(this.#def.id),
    });
    this.#pauseBtn = el("button", {
      class: "btn--icon detail-ctrl detail-pause-btn",
      type: "button",
      html: icons.pause(),
      onClick: () => this.#def && this.#onTogglePause(this.#def.id),
    });

    this.#cardsEl = el("div", { class: "detail-cards", role: "list" });

    this.#contentEl = el("div", { class: "detail-content", hidden: true }, [
      el("div", { class: "detail-title" }, [
        this.#breadcrumbEl,
        el("div", { class: "detail-controls" }, [
          this.#cardMenu.element,
          this.#pauseBtn,
          this.#armBtn,
        ]),
      ]),
      this.#cardsEl,
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

  /** Show a tunnel's details. `ctx` carries the live state, latest snapshot, and
   *  a jumpHost-by-id map for the breadcrumb. */
  show(def, { state = "disarmed", snap = null, jumpsById } = {}) {
    this.#def = def || null;
    this.#state = state;
    this.#snap = snap;
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
    const segs = [`${d.bindHost || "127.0.0.1"}:${d.localPort ?? "?"}`];
    for (const id of d.jumpHostIds || []) {
      const jh = this.#jumpsById.get(id);
      segs.push(jh ? jh.label || `${jh.host}:${jh.port}` : id);
    }
    if (typeof d.sshHost === "string" && d.sshHost.trim() !== "") {
      segs.push(`${d.sshHost}:${d.sshPort ?? 22}`);
    }
    segs.push(`${d.destination?.host ?? "?"}:${d.destination?.port ?? "?"}`);
    return segs;
  }

  #renderBreadcrumb() {
    clear(this.#breadcrumbEl);
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
    clear(this.#cardsEl);
    this.#cardNodes.clear();
    if (this.#visible.length === 0) {
      this.#cardsEl.appendChild(
        el("p", {
          class: "detail-cards-empty",
          text: t("detail.cards.empty"),
        }),
      );
      return;
    }
    for (const key of this.#visible) {
      const card = getCard(key);
      if (!card) continue;
      const valueEl = el("div", { class: "card-value" });
      const props = {
        class: "detail-card",
        role: "listitem",
        draggable: "true",
        dataset: { card: key },
        onDragstart: (e) => this.#onDragStart(e, key),
        onDragover: (e) => this.#onDragOver(e, key),
        onDragleave: () => root.classList.remove("detail-card--drop"),
        onDrop: (e) => this.#onDrop(e, key),
        onDragend: () => this.#clearDropMarks(),
      };
      // Two cards double as buttons: the State card opens the current error
      // while errored; the Errors card opens the whole error history when the
      // count is non-zero (see #updateCardAffordances for the matching cue).
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
      this.#cardsEl.appendChild(root);
    }
    this.#updateValues();
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
    this.#armBtn.classList.toggle("detail-arm-btn--armed", armed);
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

  // ── Drag-and-drop card ordering ───────────────────────────────────────────

  #onDragStart(e, key) {
    this.#dragKey = key;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Firefox requires data to be set for a drag to start.
      try {
        e.dataTransfer.setData("text/plain", key);
      } catch {
        // ignore — jsdom / restricted environments
      }
    }
    this.#cardNodes.get(key)?.root.classList.add("detail-card--dragging");
  }

  #onDragOver(e, key) {
    if (!this.#dragKey || this.#dragKey === key) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const rec = this.#cardNodes.get(key);
    if (rec) rec.root.classList.add("detail-card--drop");
  }

  #onDrop(e, key) {
    e.preventDefault();
    const from = this.#dragKey;
    this.#clearDropMarks();
    if (!from || from === key) return;
    this.#visible = reorderCards(this.#visible, from, key);
    this.#renderCards();
    this.#onCardsChange([...this.#visible]);
  }

  #clearDropMarks() {
    this.#dragKey = null;
    for (const [, rec] of this.#cardNodes) {
      rec.root.classList.remove("detail-card--drop", "detail-card--dragging");
    }
  }

  // ── Manage cards (the checklist menu — add + remove) ──────────────────────

  /** Show/hide a card from the checklist (appends when re-shown). */
  #toggleCard(key, show) {
    const shown = this.#visible.includes(key);
    if (show === shown) return;
    this.#visible = show
      ? [...this.#visible, key]
      : this.#visible.filter((k) => k !== key);
    this.#renderCards();
    this.#onCardsChange([...this.#visible]);
  }
}
