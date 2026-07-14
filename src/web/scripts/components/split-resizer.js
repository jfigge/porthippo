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

// split-resizer.js — a col-resize divider for the two-pane tunnels split. It
// resizes the LEFT (master list) column of the CSS grid by writing a pixel
// width into the `--split-left` custom property on the container. The width is
// clamped so the left pane stays ≥ minLeft and the right pane ≥ minRight. The
// user's chosen width is reported through `onCommit` (drag end / keyboard step)
// so the caller can persist it; the resizer itself is storage-agnostic. A
// window resize re-clamps the applied width without disturbing the stored
// preference, so shrinking the window never overwrites what the user picked and
// growing it back restores their choice.

import { el } from "../dom.js";

export class SplitResizer {
  #container;
  #target;
  #divider;
  #minLeft;
  #minRight;
  #onCommit;

  #preferred = null; // the user's chosen left width (px); the value we persist
  #dragging = false;
  #pointerId = null;

  #onResize;
  #onMove;
  #onUp;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.container   the element whose width is measured and
   *        against whose left edge the pointer is offset (e.g. `.tunnels-split`)
   * @param {HTMLElement} [opts.target]    the element the `--split-left` custom
   *        property is written to (defaults to `container`). Point several
   *        resizers at one shared ancestor so a single split width drives every
   *        view that inherits the property.
   * @param {number} [opts.minLeft=150]    minimum width of the left column (px)
   * @param {number} [opts.minRight=300]   minimum width of the right column (px)
   * @param {string} [opts.label]          accessible label for the divider
   * @param {(px: number) => void} [opts.onCommit]  called with the chosen width
   *        on drag end / keyboard step (never on a passive window re-clamp)
   */
  constructor({
    container,
    target,
    minLeft = 150,
    minRight = 300,
    label,
    onCommit,
  } = {}) {
    this.#container = container;
    this.#target = target || container;
    this.#minLeft = minLeft;
    this.#minRight = minRight;
    this.#onCommit = onCommit;

    this.#divider = el("div", {
      class: "tunnels-splitter",
      role: "separator",
      "aria-orientation": "vertical",
      "aria-label": label || "Resize",
      tabindex: "0",
      onpointerdown: (e) => this.#onPointerDown(e),
      onkeydown: (e) => this.#onKeyDown(e),
    });

    this.#onResize = () => this.#apply();
    this.#onMove = (e) => this.#onPointerMove(e);
    this.#onUp = (e) => this.#onPointerUp(e);
    window.addEventListener("resize", this.#onResize);
  }

  /** The draggable divider element to insert between the two panes. */
  get element() {
    return this.#divider;
  }

  /**
   * Set the preferred left width (e.g. a persisted value or the default) and
   * apply it. Does not commit — restoring a value isn't a new user choice.
   */
  setLeft(px) {
    const width = Number(px);
    if (Number.isFinite(width)) this.#preferred = width;
    this.#apply();
  }

  /** Re-apply the current preferred width (call after the split becomes visible). */
  refresh() {
    this.#apply();
  }

  destroy() {
    window.removeEventListener("resize", this.#onResize);
    this.#endDrag();
  }

  // ── Clamping ────────────────────────────────────────────────────────────────

  /** Largest left width that still leaves the right pane ≥ minRight. */
  #maxLeft() {
    const total = this.#container.clientWidth;
    const dividerW = this.#divider.offsetWidth || 0;
    return Math.max(this.#minLeft, total - dividerW - this.#minRight);
  }

  #clamp(px) {
    return Math.min(Math.max(px, this.#minLeft), this.#maxLeft());
  }

  /** Write the clamped preferred width to the CSS variable. */
  #apply() {
    if (this.#preferred == null) return;
    // Before layout (container hidden / zero-width) the max isn't knowable, so
    // only enforce the lower bound and let a later refresh()/resize clamp it.
    const px =
      this.#container.clientWidth > 0
        ? this.#clamp(this.#preferred)
        : Math.max(this.#preferred, this.#minLeft);
    this.#target.style.setProperty("--split-left", `${px}px`);
  }

  // ── Pointer drag ────────────────────────────────────────────────────────────

  #onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    this.#dragging = true;
    this.#pointerId = e.pointerId;
    try {
      this.#divider.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture is a nicety; dragging still works without it.
    }
    this.#container.classList.add("tunnels-split--resizing");
    this.#divider.addEventListener("pointermove", this.#onMove);
    this.#divider.addEventListener("pointerup", this.#onUp);
    this.#divider.addEventListener("pointercancel", this.#onUp);
  }

  #onPointerMove(e) {
    if (!this.#dragging) return;
    const rect = this.#container.getBoundingClientRect();
    this.#preferred = this.#clamp(e.clientX - rect.left);
    this.#target.style.setProperty("--split-left", `${this.#preferred}px`);
  }

  #onPointerUp() {
    if (!this.#dragging) return;
    this.#endDrag();
    if (this.#preferred != null) this.#onCommit?.(this.#preferred);
  }

  #endDrag() {
    if (this.#pointerId != null) {
      try {
        this.#divider.releasePointerCapture(this.#pointerId);
      } catch {
        // Already released (e.g. the pointer left the window) — fine.
      }
    }
    this.#pointerId = null;
    this.#dragging = false;
    this.#container.classList.remove("tunnels-split--resizing");
    this.#divider.removeEventListener("pointermove", this.#onMove);
    this.#divider.removeEventListener("pointerup", this.#onUp);
    this.#divider.removeEventListener("pointercancel", this.#onUp);
  }

  // ── Keyboard (accessible resize) ────────────────────────────────────────────

  #onKeyDown(e) {
    const step = e.shiftKey ? 40 : 10;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = -step;
    else if (e.key === "ArrowRight") delta = step;
    else return;
    e.preventDefault();
    const base = this.#preferred ?? this.#minLeft;
    this.#preferred = this.#clamp(base + delta);
    this.#apply();
    this.#onCommit?.(this.#preferred);
  }
}
