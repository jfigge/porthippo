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
 * The tray shows the bare hippo glyph — just the silhouette, no blue rounded-rect
 * background and no colour. It is a monochrome template image: `drawHippo` fills
 * the hippo body in opaque black and cuts the eyes, nostrils and the port-link
 * "tunnel" motif out as transparent holes, scaled to fill the whole canvas. On
 * macOS we flag it as a template so the menu bar tints it (black on a light bar,
 * white on a dark one) automatically; the same alpha-only glyph reads correctly
 * on every platform.
 *
 * When one or more SSH tunnels are connected, `drawBadge` composites a small
 * count badge into the bottom-right corner — a filled disc separated from the
 * hippo by a transparent moat, with the digits punched out as holes so the count
 * stays legible after the template tint flattens every opaque pixel to one colour.
 *
 * Both drawing helpers are pure (unit-tested with no Electron) and work in a plain
 * premultiplied-RGBA pixel buffer of pure-black pixels. The Electron `nativeImage`
 * is injected and only used to wrap the finished pixels (`createFromBitmap`).
 */
"use strict";

// Physical canvas edge. Presented at scaleFactor 2 → 16pt logical, matching the
// menu-bar / tray sizing conventions used elsewhere in the app.
const SIZE = 32;

// The hippo geometry, in the 512×512 viewBox of website/favicon.svg. Only the
// hippo itself (ears + head + snout, minus the facial cut-outs) — the blue plate
// is dropped. The union's bounding box is x∈[118,394], y∈[106,410]; we centre and
// scale that box to fill the tray canvas.
const VB_CENTER_X = 256;
const VB_CENTER_Y = 258;
const VB_HEIGHT = 304;

// Solid hippo body (union of these shapes).
const HIPPO_FILLS = [
  { disc: [170, 146, 40] }, // left ear
  { disc: [342, 146, 40] }, // right ear
  { rrect: [144, 140, 224, 190, 74] }, // head
  { rrect: [118, 260, 276, 150, 74] }, // snout
];

// Facial features, subtracted from the body as transparent holes.
const HIPPO_HOLES = [
  { disc: [201, 198, 17] }, // left eye
  { disc: [311, 198, 17] }, // right eye
  { ellipse: [210, 332, 18, 23] }, // left nostril
  { ellipse: [302, 332, 18, 23] }, // right nostril
  { seg: [210, 332, 302, 332, 6.5] }, // port-link tunnel motif
];

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
  // A bang for the error-health badge (Feature 130): a stroke over a gap + dot.
  "!": [0b010, 0b010, 0b010, 0b000, 0b010],
};

// ── Shape containment (in canvas-pixel space) ──────────────────────────────────

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Does a rounded rectangle (top-left x,y, width w, height h, corner r) contain the
// point? Uses the standard rounded-box signed-distance test.
function inRoundRect(px, py, x, y, w, h, r) {
  const hw = w / 2;
  const hh = h / 2;
  const qx = Math.max(Math.abs(px - (x + hw)) - (hw - r), 0);
  const qy = Math.max(Math.abs(py - (y + hh)) - (hh - r), 0);
  return Math.hypot(qx, qy) <= r;
}

// Distance from a point to a line segment (used for the round-capped port link).
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function contains(shape, px, py) {
  if (shape.disc) {
    const [cx, cy, r] = shape.disc;
    return Math.hypot(px - cx, py - cy) <= r;
  }
  if (shape.ellipse) {
    const [cx, cy, rx, ry] = shape.ellipse;
    const nx = (px - cx) / rx;
    const ny = (py - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  if (shape.rrect) {
    return inRoundRect(px, py, ...shape.rrect);
  }
  if (shape.seg) {
    const [x1, y1, x2, y2, hw] = shape.seg;
    return distToSegment(px, py, x1, y1, x2, y2) <= hw;
  }
  return false;
}

const inAny = (shapes, px, py) => shapes.some((s) => contains(s, px, py));

// Map a shape's viewBox coordinates into canvas-pixel space (centre + scale to
// fill the canvas). Lengths (radii, widths) scale; points also translate.
function transformShape(shape, tx, ty, scale) {
  if (shape.disc) {
    const [cx, cy, r] = shape.disc;
    return { disc: [tx(cx), ty(cy), r * scale] };
  }
  if (shape.ellipse) {
    const [cx, cy, rx, ry] = shape.ellipse;
    return { ellipse: [tx(cx), ty(cy), rx * scale, ry * scale] };
  }
  if (shape.rrect) {
    const [x, y, w, h, r] = shape.rrect;
    return { rrect: [tx(x), ty(y), w * scale, h * scale, r * scale] };
  }
  if (shape.seg) {
    const [x1, y1, x2, y2, hw] = shape.seg;
    return { seg: [tx(x1), ty(y1), tx(x2), ty(y2), hw * scale] };
  }
  return shape;
}

/**
 * Draw the monochrome hippo glyph into a premultiplied-RGBA buffer, in place.
 * The body is opaque black; the eyes, nostrils and port link are punched out as
 * transparent holes. Edges (and holes) are antialiased via 3×3 supersampling.
 *
 * @param {Buffer|Uint8ClampedArray} rgba  premultiplied RGBA, length size*size*4
 * @param {number} size  square edge in pixels
 * @returns {typeof rgba} the same buffer, for chaining
 */
function drawHippo(rgba, size) {
  const margin = size * 0.05;
  const scale = (size - 2 * margin) / VB_HEIGHT;
  const tx = (x) => (x - VB_CENTER_X) * scale + size / 2;
  const ty = (y) => (y - VB_CENTER_Y) * scale + size / 2;

  const fills = HIPPO_FILLS.map((s) => transformShape(s, tx, ty, scale));
  const holes = HIPPO_HOLES.map((s) => transformShape(s, tx, ty, scale));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3 - 0.5;
          const py = y + (sy + 0.5) / 3 - 0.5;
          if (inAny(fills, px, py) && !inAny(holes, px, py)) hits++;
        }
      }
      if (hits) {
        // Pure-black premultiplied pixel; only alpha carries the coverage.
        rgba[(y * size + x) * 4 + 3] = Math.round((hits / 9) * 255);
      }
    }
  }
  return rgba;
}

// ── Badge ──────────────────────────────────────────────────────────────────────

// Fill an antialiased disc (3×3 supersampled coverage) with opaque black.
function fillDisc(rgba, size, cx, cy, radius) {
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
      if (hits) {
        const a = Math.round((hits / 9) * 255);
        const idx = (y * size + x) * 4;
        if (a > rgba[idx + 3]) rgba[idx + 3] = a; // black body → raise alpha only
      }
    }
  }
}

// Clear an antialiased disc to transparent (a "moat" that separates the badge from
// the hippo). Scales every channel down by the sample coverage.
function clearDisc(rgba, size, cx, cy, radius) {
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
      if (hits) {
        const keep = 1 - hits / 9;
        const idx = (y * size + x) * 4;
        rgba[idx + 3] = Math.round(rgba[idx + 3] * keep);
      }
    }
  }
}

/**
 * Composite a corner badge onto a premultiplied-RGBA buffer, in place. `value` is
 * either a connected-tunnel COUNT (a number — counts above nine render as "9+", a
 * count below one leaves the buffer untouched) or a short TEXT badge (a string,
 * e.g. "!" for the error-health state, Feature 130 — capped at two glyphs).
 *
 * The badge is a filled black disc ringed by a transparent moat (so it stands off
 * the hippo) with the digits punched out as transparent holes — an alpha-only
 * design that survives the macOS template tint without losing the number.
 *
 * @param {Buffer|Uint8ClampedArray} rgba  premultiplied RGBA, length size*size*4
 * @param {number} size  square edge in pixels
 * @param {number|string} value  connected-tunnel count, or a short text badge
 * @returns {typeof rgba} the same buffer, for chaining
 */
function drawBadge(rgba, size, value) {
  let text;
  if (typeof value === "string") {
    if (!value) return rgba;
    text = value.slice(0, 2);
  } else {
    if (!value || value < 1) return rgba;
    text = value > 9 ? "9+" : String(value);
  }

  // Disc tucked into the bottom-right corner, held off the hippo by a moat.
  const r = size * 0.32;
  const cx = size - r - 1;
  const cy = size - r - 1;
  const moat = Math.max(1, Math.round(size * 0.06));
  clearDisc(rgba, size, cx, cy, r + moat);
  fillDisc(rgba, size, cx, cy, r);

  // Size the digits to fit the disc interior (room for up to two characters).
  const interior = 2 * r * 0.85;
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
            // Punch the digit out (transparent) so it reads against the disc.
            rgba[(py * size + px) * 4 + 3] = 0;
          }
        }
      }
    }
  }
  return rgba;
}

/**
 * Build the tray image: the monochrome hippo glyph, with a connected-count badge
 * when `count > 0`. Presented at scaleFactor 2 (16pt logical) so it stays crisp on
 * retina menu bars. When `template` is set (macOS), the image is flagged as a
 * template so the menu bar tints it for the active light/dark appearance.
 *
 * When `health` is "error" (Feature 130) the badge shows a bang instead of the
 * count, so a gave-up / errored tunnel is visible at a glance in the menu bar;
 * "reconnecting" and "healthy" keep the connected-count badge (the tooltip / menu
 * carry the finer health text).
 *
 * @param {object} deps
 * @param {typeof Electron.nativeImage} deps.nativeImage
 * @param {number} [deps.count=0]  connected-tunnel count to badge
 * @param {boolean} [deps.template=false]  flag the image as a macOS template
 * @param {"healthy"|"reconnecting"|"error"} [deps.health="healthy"]  rollup state
 * @returns {Electron.NativeImage}
 */
function buildTrayImage({
  nativeImage,
  count = 0,
  template = false,
  health = "healthy",
} = {}) {
  const buf = Buffer.alloc(SIZE * SIZE * 4); // transparent, pure-black pixels
  drawHippo(buf, SIZE);
  if (health === "error") drawBadge(buf, SIZE, "!");
  else if (count > 0) drawBadge(buf, SIZE, count);

  // The buffer is pure-black premultiplied RGBA; with R=B=0 it is byte-identical
  // to the BGRA order createFromBitmap expects, so no channel swap is needed.
  const image = nativeImage.createFromBitmap(buf, {
    width: SIZE,
    height: SIZE,
    scaleFactor: 2,
  });
  if (template && typeof image.setTemplateImage === "function") {
    image.setTemplateImage(true);
  }
  return image;
}

module.exports = { buildTrayImage, drawHippo, drawBadge, SIZE };
