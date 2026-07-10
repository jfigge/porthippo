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

/**
 * tray-icon.js — the tray / menu-bar image.
 *
 * The tray shows the bundled colour app icon (the hippo) on every platform. When
 * one or more SSH tunnels are connected we composite a small red count badge onto
 * the icon's bottom-right corner so the connected count is visible at a glance —
 * the same badge on macOS, Windows and Linux.
 *
 * The badge is drawn in a plain RGBA pixel buffer by `drawBadge` (pure, unit-
 * tested with no Electron) using a tiny 3×5 bitmap font. The Electron
 * `nativeImage` is injected and only used to load/resize the base icon and to
 * shuttle raw pixels in (`toBitmap`) and out (`createFromBitmap`).
 */
"use strict";

// Physical canvas edge. Presented at scaleFactor 2 → 16pt logical, matching the
// menu-bar / tray sizing conventions used elsewhere in the app.
const SIZE = 32;

// Badge colours (straight, opaque).
const BADGE_RGB = [0xe5, 0x48, 0x4d]; // red disc
const BADGE_INK_RGB = [0xff, 0xff, 0xff]; // white ring + digits

// 3×5 bitmap font: each glyph is five rows of three bits, MSB = leftmost column.
const GLYPH_W = 3;
const GLYPH_H = 5;
// prettier-ignore
const GLYPHS = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b001, 0b001, 0b001],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
  "+": [0b000, 0b010, 0b111, 0b010, 0b000],
};

// Composite a straight-alpha colour over a premultiplied-RGBA pixel ("over").
function blendOver(rgba, idx, r, g, b, a) {
  const inv = 1 - a;
  rgba[idx] = Math.round(r * a + rgba[idx] * inv);
  rgba[idx + 1] = Math.round(g * a + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(b * a + rgba[idx + 2] * inv);
  rgba[idx + 3] = Math.round(a * 255 + rgba[idx + 3] * inv);
}

// Fill an antialiased disc (3×3 supersampled coverage) in the given colour.
function fillDisc(rgba, size, cx, cy, radius, rgb) {
  const minY = Math.max(0, Math.floor(cy - radius - 1));
  const maxY = Math.min(size - 1, Math.ceil(cy + radius + 1));
  const minX = Math.max(0, Math.floor(cx - radius - 1));
  const maxX = Math.min(size - 1, Math.ceil(cx + radius + 1));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3 - 0.5;
          const py = y + (sy + 0.5) / 3 - 0.5;
          if (Math.hypot(px - cx, py - cy) <= radius) hits++;
        }
      }
      if (hits)
        blendOver(rgba, (y * size + x) * 4, rgb[0], rgb[1], rgb[2], hits / 9);
    }
  }
}

/**
 * Composite a red connected-count badge onto an RGBA pixel buffer, in place.
 * Counts above nine render as "9+". A count below one leaves the buffer untouched.
 *
 * @param {Buffer|Uint8ClampedArray} rgba  premultiplied RGBA, length size*size*4
 * @param {number} size  square edge in pixels
 * @param {number} count connected-tunnel count
 * @returns {typeof rgba} the same buffer, for chaining
 */
function drawBadge(rgba, size, count) {
  if (!count || count < 1) return rgba;
  const text = count > 9 ? "9+" : String(count);

  // Disc tucked into the bottom-right corner, with a white halo for contrast.
  const r = size * 0.32;
  const cx = size - r - 1;
  const cy = size - r - 1;
  const ring = Math.max(1, Math.round(size * 0.06));
  fillDisc(rgba, size, cx, cy, r, BADGE_INK_RGB);
  fillDisc(rgba, size, cx, cy, r - ring, BADGE_RGB);

  // Size the digits to fit the red interior (room for up to two characters).
  const interior = 2 * (r - ring) * 0.9;
  const wScale = Math.floor(interior / (2 * GLYPH_W + 1));
  const hScale = Math.floor(interior / GLYPH_H);
  const scale = Math.max(1, Math.min(wScale, hScale));

  const textW = text.length * GLYPH_W * scale + (text.length - 1) * scale;
  const originX = Math.round(cx - textW / 2);
  const originY = Math.round(cy - (GLYPH_H * scale) / 2);
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]];
    if (!glyph) continue;
    const gx0 = originX + i * (GLYPH_W + 1) * scale;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gc = 0; gc < GLYPH_W; gc++) {
        if (!((glyph[gy] >> (GLYPH_W - 1 - gc)) & 1)) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = gx0 + gc * scale + sx;
            const py = originY + gy * scale + sy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const [ir, ig, ib] = BADGE_INK_RGB;
            blendOver(rgba, (py * size + px) * 4, ir, ig, ib, 1);
          }
        }
      }
    }
  }
  return rgba;
}

// Swap the R and B channels of a packed 4-byte-pixel buffer, in place. Electron's
// nativeImage bitmaps are BGRA; drawBadge works in RGBA, so we flip on the way in
// and back out again.
function swapRB(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    const t = buf[i];
    buf[i] = buf[i + 2];
    buf[i + 2] = t;
  }
  return buf;
}

/**
 * Build the tray image: the colour app icon, with a connected-count badge when
 * `count > 0`. Presented at scaleFactor 2 (16pt logical) so it stays crisp on
 * retina menu bars.
 *
 * @param {object} deps
 * @param {typeof Electron.nativeImage} deps.nativeImage
 * @param {string} [deps.colorIconPath]  path to the colour app icon PNG
 * @param {number} [deps.count=0]  connected-tunnel count to badge
 * @returns {Electron.NativeImage}
 */
function buildTrayImage({ nativeImage, colorIconPath, count = 0 } = {}) {
  let base = colorIconPath
    ? nativeImage.createFromPath(colorIconPath)
    : nativeImage.createEmpty();
  if (base.isEmpty()) return base;
  base = base.resize({ width: SIZE, height: SIZE, quality: "best" });

  const buf = base.toBitmap(); // premultiplied BGRA
  if (count > 0) {
    swapRB(buf); // → RGBA
    drawBadge(buf, SIZE, count);
    swapRB(buf); // → BGRA
  }
  return nativeImage.createFromBitmap(buf, {
    width: SIZE,
    height: SIZE,
    scaleFactor: 2,
  });
}

module.exports = { buildTrayImage, drawBadge, SIZE };
