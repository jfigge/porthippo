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

// zoom-handlers.js — UI zoom ("font size") input handlers. Ported from Rest
// Hippo's event-bus/zoom-handlers.js. Owns the three paths that step the global
// UI font size: Ctrl/Cmd + wheel or pinch, the Ctrl/Cmd + '+' / '-' / '0'
// keyboard shortcuts, and the `porthippo:ui-font-change` events the native menu
// re-dispatches (via preload). Each step commits a new fontSize setting through
// `ctx.setFontSize`, which persists it and applies the matching Chromium zoom
// factor so the whole (px-authored) UI scales.
//
// The allowed sizes MUST stay in sync with the <option> list in settings-popup.js.

export const FONT_SIZES = [11, 12, 13, 14, 16, 18];
export const DEFAULT_FONT_SIZE = 13;

/**
 * Install the zoom input handlers on `window`.
 * @param {object} ctx
 * @param {() => number} ctx.getFontSize   current fontSize (px)
 * @param {(size: number) => void} ctx.setFontSize   persist + apply a new size
 */
export function installZoomHandlers(ctx) {
  /**
   * Advance the font size by `direction` steps (+1 = larger, -1 = smaller). If
   * the current value isn't in the list, the nearest entry is the start point.
   * Silently no-ops when already at the boundary.
   */
  function changeFontByStep(direction) {
    const current = ctx.getFontSize() ?? DEFAULT_FONT_SIZE;

    let idx = FONT_SIZES.indexOf(current);
    if (idx === -1) {
      const nearest = FONT_SIZES.reduce((prev, cur) =>
        Math.abs(cur - current) < Math.abs(prev - current) ? cur : prev,
      );
      idx = FONT_SIZES.indexOf(nearest);
    }

    const nextIdx = Math.max(
      0,
      Math.min(FONT_SIZES.length - 1, idx + direction),
    );
    const newSize = FONT_SIZES[nextIdx];
    if (newSize === current) return; // already at min/max limit
    ctx.setFontSize(newSize);
  }

  /** Reset to the default font size. */
  function resetFont() {
    if ((ctx.getFontSize() ?? DEFAULT_FONT_SIZE) === DEFAULT_FONT_SIZE) return;
    ctx.setFontSize(DEFAULT_FONT_SIZE);
  }

  // ── Wheel / pinch ────────────────────────────────────────────────────────
  // Non-passive so preventDefault() stops the browser's native visual zoom. On
  // macOS a two-finger pinch reaches Chromium as a wheel event with ctrlKey.
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return; // only zoom-modifier combos
      e.preventDefault();
      e.stopPropagation();
      // Negative deltaY = scroll/pinch toward "zoom in"; positive = "zoom out".
      changeFontByStep(e.deltaY < 0 ? +1 : -1);
    },
    { passive: false, capture: true },
  );

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  // Ctrl/Cmd + '+' / '-' / '0', in the capture phase so they fire before any
  // focused widget and before Chromium's built-in zoom.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.altKey) return; // leave ⌥-modified combos alone

      // Let normal key combos work inside editable fields.
      const tag = e.target?.tagName ?? "";
      if (["INPUT", "TEXTAREA"].includes(tag) || e.target?.isContentEditable) {
        return;
      }

      // '+' (shift+= on US layouts) and '=' both zoom in; '-' zooms out.
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(+1);
      } else if (e.key === "-") {
        e.preventDefault();
        e.stopPropagation();
        changeFontByStep(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        e.stopPropagation();
        resetFont();
      }
    },
    { capture: true },
  );

  // ── Native menu (main → preload → renderer) ────────────────────────────────
  // The View menu's Increase/Decrease/Reset Font Size items send "menu:font-change",
  // which preload re-dispatches as this CustomEvent.
  window.addEventListener("porthippo:ui-font-change", (e) => {
    const direction = e.detail;
    if (direction === "in") changeFontByStep(+1);
    else if (direction === "out") changeFontByStep(-1);
    else if (direction === "reset") resetFont();
  });
}
