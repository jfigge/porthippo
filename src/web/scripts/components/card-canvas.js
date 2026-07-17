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

// card-canvas.js — the snap-to-grid infinite canvas that lays out the tunnel
// detail's stat cards. It owns none of the card content (TunnelDetail builds the
// nodes and updates their values); it owns only *where* each card sits. Cards are
// absolutely positioned on a scrolling surface sized tight to the placed cards'
// bounding box at rest; only while a drag is live does it expand (dragSize) to
// give the grid room to drop a card further out. Positions are a {col,row}
// map: the owner hands in one layout shared by every tunnel, adopted on a tunnel
// switch (keyed by the id below), kept while only the visible set changes, and
// reported back via `onLayoutChange` so the owner can persist it.
//
// Dragging is pointer-based (not native DnD) so the card can be lifted and kept
// under the cursor: on drag it scales up, casts a shadow, reveals a faint dashed
// grid, and ghosts the target cell — a free "snap" cell in accent, or, over an
// occupied cell, the occupant is highlighted and the drag's origin marked
// "vacated" (where the occupant will slide). The pure placement/swap/return-home
// logic lives in grid-layout.js.

import { el } from "../dom.js";
import {
  CELL,
  cellLeft,
  cellTop,
  cellAt,
  applyDrop,
  placeCards,
  contentSize,
  dragSize,
  boundingBox,
} from "./grid-layout.js";

// Pointer travel (px) before a press becomes a drag — below it, the press is left
// alone so a click (e.g. an errored State card) still fires.
const DRAG_THRESHOLD = 4;

// A faint dashed cell, tiled across the drag overlay. A neutral mid-grey reads on
// both the light and dark surfaces without a theme-specific asset.
const GRID_TILE = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CELL.w + CELL.gap}" height="${
    CELL.h + CELL.gap
  }"><rect x="0.5" y="0.5" width="${CELL.w - 1}" height="${
    CELL.h - 1
  }" rx="8" fill="none" stroke="rgba(128,128,128,0.45)" stroke-width="1" stroke-dasharray="4 5"/></svg>`,
);

export class CardCanvas {
  #el; // the scroll container (.detail-cards)
  #surface; // the sized content layer (.detail-cards-surface)
  #overlay; // the dashed grid, shown only while dragging
  #snapGhost; // accent ghost of a free target cell
  #vacatedGhost; // marker of the origin cell during a swap

  #onLayoutChange;
  #onDeleteHover;
  #onDelete;
  #deleteZone = null; // element that, when a card is dropped on it, removes it

  #tunnelId = null;
  #positions = {}; // key → {col,row}
  #homes = {}; // key → {col,row} home of a displaced card (session-only)
  #nodes = new Map(); // key → card element

  #drag = null;
  #hlKey = null; // currently swap-highlighted occupant key
  #suppressNextClick = false;

  #onPointerMove;
  #onPointerUp;

  constructor({ onLayoutChange, onDeleteHover, onDelete } = {}) {
    this.#onLayoutChange = onLayoutChange || (() => {});
    this.#onDeleteHover = onDeleteHover || (() => {});
    this.#onDelete = onDelete || (() => {});
    this.#onPointerMove = (e) => this.#pointerMove(e);
    this.#onPointerUp = (e) => this.#pointerUp(e);
    this.#build();
  }

  get element() {
    return this.#el;
  }

  /** The element a card can be dropped onto to remove it (the Data Fields
   *  selector). Lives outside the canvas, so it's hit-tested by client rect. */
  setDeleteZone(el) {
    this.#deleteZone = el || null;
  }

  #build() {
    this.#overlay = el("div", {
      class: "card-grid-overlay",
      "aria-hidden": "true",
      hidden: true,
      style: {
        backgroundImage: `url("data:image/svg+xml,${GRID_TILE}")`,
        backgroundSize: `${CELL.w + CELL.gap}px ${CELL.h + CELL.gap}px`,
      },
    });
    this.#snapGhost = el("div", {
      class: "card-grid-ghost card-grid-ghost--snap",
      "aria-hidden": "true",
      hidden: true,
    });
    this.#vacatedGhost = el("div", {
      class: "card-grid-ghost card-grid-ghost--vacated",
      "aria-hidden": "true",
      hidden: true,
    });

    this.#surface = el("div", { class: "detail-cards-surface", role: "list" }, [
      this.#overlay,
      this.#snapGhost,
      this.#vacatedGhost,
    ]);

    this.#el = el("div", { class: "detail-cards" }, [this.#surface]);
    this.#el.addEventListener("pointerdown", (e) => this.#pointerDown(e));
    this.#el.addEventListener("dblclick", (e) => this.#fitToContent(e));
    // A drag ends with a synthetic click on the card — swallow that one so a
    // dropped State/Errors card doesn't also fire its activation.
    this.#el.addEventListener("click", (e) => this.#clickCapture(e), true);
  }

  /**
   * Adopt the visible cards and lay them out. On a tunnel switch the stored
   * layout is taken as the base and any displacement state is cleared; while the
   * same tunnel's visible set merely changes, the live positions are kept and
   * only added/removed cards are (un)placed. Newly assigned cells are reported.
   *
   * @param {string} tunnelId
   * @param {Array<{key:string, node:HTMLElement}>} entries  in render order
   * @param {Object<string,{col:number,row:number}>|null} storedLayout
   */
  setCards(tunnelId, entries, storedLayout) {
    const switched = tunnelId !== this.#tunnelId;
    this.#tunnelId = tunnelId;
    const keys = entries.map((e) => e.key);

    const base = switched ? storedLayout || {} : this.#positions;
    const { positions, changed } = placeCards(keys, base);
    this.#positions = positions;
    if (switched) this.#homes = {};
    else this.#pruneHomes(keys);

    this.#nodes = new Map(entries.map((e) => [e.key, e.node]));
    this.#renderSurface(entries);
    this.#resize();

    if (changed) this.#emitLayout();
  }

  /** Drop the surface's card nodes and re-append them at their cells. */
  #renderSurface(entries) {
    for (const node of this.#surface.querySelectorAll(".detail-card")) {
      node.remove();
    }
    // Suppress the drop-into-place transition for this initial batch, then let
    // real moves animate again on the next frame.
    this.#surface.classList.add("detail-cards-surface--no-anim");
    for (const { key, node } of entries) {
      this.#applyTransform(node, this.#positions[key]);
      this.#surface.appendChild(node);
    }
    const raf =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (fn) => fn();
    raf(() => this.#surface.classList.remove("detail-cards-surface--no-anim"));
  }

  #pruneHomes(keys) {
    const visible = new Set(keys);
    for (const k of Object.keys(this.#homes)) {
      if (!visible.has(k)) delete this.#homes[k];
    }
  }

  #applyTransform(node, cell) {
    if (!node || !cell) return;
    node.style.transform = `translate(${cellLeft(cell.col)}px, ${cellTop(
      cell.row,
    )}px)`;
  }

  /** Size the surface: tight to the cards at rest, expanded while dragging so
   *  the revealed grid has drop room beyond the placed cards. */
  #resize() {
    const size = this.#drag?.lifted
      ? dragSize(this.#positions)
      : contentSize(this.#positions);
    this.#surface.style.width = `${size.width}px`;
    this.#surface.style.height = `${size.height}px`;
  }

  #emitLayout() {
    const snapshot = {};
    for (const [k, p] of Object.entries(this.#positions)) {
      snapshot[k] = { col: p.col, row: p.row };
    }
    this.#onLayoutChange(snapshot);
  }

  // ── Drag ────────────────────────────────────────────────────────────────────

  #surfacePoint(e) {
    const r = this.#surface.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  #pointerDown(e) {
    if (this.#drag || (e.button != null && e.button !== 0)) return;
    // A fresh press: clear any stale click-swallow flag from a prior drag that
    // ended without a following click (drag released off its start element).
    this.#suppressNextClick = false;
    const cardEl = e.target.closest && e.target.closest(".detail-card");
    if (!cardEl || !this.#surface.contains(cardEl)) return;
    const key = cardEl.dataset.card;
    const pos = this.#positions[key];
    if (!pos) return;

    const pt = this.#surfacePoint(e);
    this.#drag = {
      key,
      cardEl,
      pointerId: e.pointerId,
      grabDX: pt.x - cellLeft(pos.col),
      grabDY: pt.y - cellTop(pos.row),
      startX: pt.x,
      startY: pt.y,
      lifted: false,
      target: pos,
      overDelete: false,
    };
    // Capture on the card (like SplitResizer's divider) so the drag keeps
    // tracking — and reliably ends — even if the pointer leaves the window. The
    // move/up/cancel listeners live on the card, which the capture retargets to.
    if (e.pointerId != null && cardEl.setPointerCapture) {
      try {
        cardEl.setPointerCapture(e.pointerId);
      } catch {
        // Capture is a nicety; the drag still works without it.
      }
    }
    cardEl.addEventListener("pointermove", this.#onPointerMove);
    cardEl.addEventListener("pointerup", this.#onPointerUp);
    cardEl.addEventListener("pointercancel", this.#onPointerUp);
  }

  #pointerMove(e) {
    const d = this.#drag;
    if (!d) return;
    const pt = this.#surfacePoint(e);
    if (!d.lifted) {
      if (Math.hypot(pt.x - d.startX, pt.y - d.startY) < DRAG_THRESHOLD) return;
      this.#lift(d);
    }
    const cardX = pt.x - d.grabDX;
    const cardY = pt.y - d.grabDY;
    d.cardEl.style.transform = `translate(${cardX}px, ${cardY}px) scale(1.04)`;

    // Over the Data Fields selector → the drop will remove the card, not place
    // it; flip the selector into a trash target and drop the snap preview.
    const overDelete = this.#hitDeleteZone(e);
    if (overDelete !== d.overDelete) {
      d.overDelete = overDelete;
      d.cardEl.classList.toggle("detail-card--will-delete", overDelete);
      this.#onDeleteHover(overDelete);
    }
    if (overDelete) {
      this.#clearPreview();
    } else {
      d.target = cellAt(cardX, cardY);
      this.#updatePreview(d);
    }
    if (e.preventDefault) e.preventDefault();
  }

  /** True when the pointer is over the delete zone (client-rect hit test). */
  #hitDeleteZone(e) {
    if (!this.#deleteZone || !this.#deleteZone.getBoundingClientRect)
      return false;
    const r = this.#deleteZone.getBoundingClientRect();
    if (!r || (r.width === 0 && r.height === 0)) return false;
    return (
      e.clientX >= r.left &&
      e.clientX <= r.right &&
      e.clientY >= r.top &&
      e.clientY <= r.bottom
    );
  }

  #lift(d) {
    d.lifted = true;
    d.cardEl.classList.add("detail-card--dragging");
    d.cardEl.style.transition = "none";
    d.cardEl.style.zIndex = "20";
    this.#overlay.hidden = false;
    this.#resize(); // expand the surface with drag room while the grid shows
  }

  /** Reflect the drag target: a free "snap" cell, or an occupied-cell swap. */
  #updatePreview(d) {
    const occKey = this.#keyAtCell(d.target, d.key);
    if (this.#hlKey && this.#hlKey !== occKey) {
      this.#nodes
        .get(this.#hlKey)
        ?.classList.remove("detail-card--swap-target");
    }
    if (occKey) {
      this.#nodes.get(occKey)?.classList.add("detail-card--swap-target");
      this.#hlKey = occKey;
      this.#placeGhost(this.#vacatedGhost, this.#positions[d.key]);
      this.#snapGhost.hidden = true;
    } else {
      if (this.#hlKey) {
        this.#nodes
          .get(this.#hlKey)
          ?.classList.remove("detail-card--swap-target");
        this.#hlKey = null;
      }
      this.#placeGhost(this.#snapGhost, d.target);
      this.#vacatedGhost.hidden = true;
    }
  }

  #placeGhost(ghost, cell) {
    this.#applyTransform(ghost, cell);
    ghost.hidden = false;
  }

  #keyAtCell(cell, exceptKey) {
    for (const [k, p] of Object.entries(this.#positions)) {
      if (k === exceptKey || !p) continue;
      if (p.col === cell.col && p.row === cell.row) return k;
    }
    return null;
  }

  #pointerUp(e) {
    const d = this.#drag;
    this.#drag = null;
    if (d) {
      d.cardEl.removeEventListener("pointermove", this.#onPointerMove);
      d.cardEl.removeEventListener("pointerup", this.#onPointerUp);
      d.cardEl.removeEventListener("pointercancel", this.#onPointerUp);
      if (d.pointerId != null && d.cardEl.releasePointerCapture) {
        try {
          d.cardEl.releasePointerCapture(d.pointerId);
        } catch {
          // Already released (e.g. the pointer left the window) — fine.
        }
      }
    }
    if (!d) return;
    if (!d.lifted) return; // a click, not a drag — leave it be

    const cancelled = e && e.type === "pointercancel";
    const deleting = d.overDelete && !cancelled;
    this.#clearDragVisuals(d);
    this.#suppressNextClick = true;
    if (cancelled) {
      this.#applyTransform(d.cardEl, this.#positions[d.key]);
    } else if (deleting) {
      // Dropped on the Data Fields selector → remove + deselect the field. The
      // owner re-renders without it, which drops the dragged node from the DOM.
      this.#onDelete(d.key);
    } else {
      this.#commitDrop(d.key, d.target);
    }
  }

  #clearPreview() {
    this.#snapGhost.hidden = true;
    this.#vacatedGhost.hidden = true;
    if (this.#hlKey) {
      this.#nodes
        .get(this.#hlKey)
        ?.classList.remove("detail-card--swap-target");
      this.#hlKey = null;
    }
  }

  #clearDragVisuals(d) {
    d.cardEl.classList.remove(
      "detail-card--dragging",
      "detail-card--will-delete",
    );
    d.cardEl.style.transition = "";
    d.cardEl.style.zIndex = "";
    this.#overlay.hidden = true;
    this.#resize(); // the drag is over — shrink back tight to the cards
    this.#clearPreview();
    if (d.overDelete) this.#onDeleteHover(false);
  }

  #commitDrop(key, cell) {
    const result = applyDrop(
      { positions: this.#positions, homes: this.#homes },
      key,
      cell,
    );
    if (!result) {
      // No change — settle the lifted card back into its own cell.
      this.#applyTransform(this.#nodes.get(key), this.#positions[key]);
      return;
    }
    this.#positions = result.positions;
    this.#homes = result.homes;
    this.#resize();
    for (const k of result.moved) {
      this.#applyTransform(this.#nodes.get(k), this.#positions[k]);
    }
    this.#emitLayout();
  }

  #clickCapture(e) {
    if (!this.#suppressNextClick) return;
    this.#suppressNextClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // ── Fit to content (double-click empty canvas) ──────────────────────────────

  #fitToContent(e) {
    if (e.target.closest && e.target.closest(".detail-card")) return;
    const box = boundingBox(this.#positions);
    if (!box) return;
    const left = cellLeft(box.minCol);
    const top = cellTop(box.minRow);
    const width = cellLeft(box.maxCol) + CELL.w - left;
    const height = cellTop(box.maxRow) + CELL.h - top;
    const view = this.#el;
    view.scrollLeft = Math.max(0, left + width / 2 - view.clientWidth / 2);
    view.scrollTop = Math.max(0, top + height / 2 - view.clientHeight / 2);
  }
}
