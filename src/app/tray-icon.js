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
 * tray-icon.js — the tray/menu-bar image.
 *
 * The bundled app icon is a full-colour hippo on an OPAQUE rounded square, so
 * its alpha silhouette is a useless solid blob as a macOS "template" image. So
 * for macOS we synthesise a crisp monochrome glyph (a "port" ring) at runtime —
 * a black-on-transparent PNG built here with a tiny zlib-backed encoder, marked
 * as a template so the menu bar tints it for light/dark automatically. On
 * Windows/Linux the tray sits on a coloured taskbar where a black glyph could
 * vanish, so we use the existing colour app icon instead.
 *
 * Dependency-free (Node's `zlib` only); the Electron `nativeImage` is injected.
 */
"use strict";

const zlib = require("zlib");

// ── Minimal PNG encoder (8-bit RGBA, single IDAT) ────────────────────────────

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an RGBA pixel buffer to a PNG.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba  length width*height*4
 * @returns {Buffer}
 */
function pngEncode(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 = compression / filter / interlace = 0

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter byte: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Rasterize a black, antialiased ring ("port") on a transparent field.
 * @param {number} size  square edge in pixels
 * @returns {Buffer} RGBA
 */
function ringGlyph(size) {
  const rgba = Buffer.alloc(size * size * 4); // zeroed = transparent
  const center = (size - 1) / 2;
  const outer = size * 0.44;
  const inner = size * 0.22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 3×3 supersample for a smooth edge at small sizes.
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          const px = x + (sx + 0.5) / 3 - 0.5;
          const py = y + (sy + 0.5) / 3 - 0.5;
          const d = Math.hypot(px - center, py - center);
          if (d <= outer && d >= inner) hits++;
        }
      }
      if (hits) {
        const i = (y * size + x) * 4;
        rgba[i] = 0; // R
        rgba[i + 1] = 0; // G
        rgba[i + 2] = 0; // B
        rgba[i + 3] = Math.round((hits / 9) * 255); // A
      }
    }
  }
  return rgba;
}

/**
 * Build the tray image for the current platform.
 * @param {object} deps
 * @param {typeof Electron.nativeImage} deps.nativeImage
 * @param {string} [deps.platform=process.platform]
 * @param {string} [deps.colorIconPath]  colour icon for Windows/Linux
 * @returns {Electron.NativeImage}
 */
function buildTrayImage({
  nativeImage,
  platform = process.platform,
  colorIconPath,
} = {}) {
  if (platform === "darwin") {
    const img = nativeImage.createFromBuffer(pngEncode(16, 16, ringGlyph(16)), {
      width: 16,
      height: 16,
      scaleFactor: 1,
    });
    try {
      img.addRepresentation({
        scaleFactor: 2,
        width: 16,
        height: 16,
        buffer: pngEncode(32, 32, ringGlyph(32)),
      });
    } catch {
      // A single representation is fine if adding the @2x rep is unsupported.
    }
    img.setTemplateImage(true);
    return img;
  }

  // Windows / Linux: the colour app icon, sized for the tray.
  let img = colorIconPath
    ? nativeImage.createFromPath(colorIconPath)
    : nativeImage.createEmpty();
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
  return img;
}

module.exports = { buildTrayImage, pngEncode, ringGlyph };
