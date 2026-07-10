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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTrayImage, drawBadge, SIZE } = require("../tray-icon");

// An opaque blue RGBA canvas, standing in for the resized colour app icon.
function blueCanvas() {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 0; // R
    buf[i + 1] = 0; // G
    buf[i + 2] = 255; // B
    buf[i + 3] = 255; // A
  }
  return buf;
}

const px = (buf, x, y) => {
  const i = (y * SIZE + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
};

test("drawBadge leaves the buffer untouched when the count is zero", () => {
  const before = blueCanvas();
  const after = Buffer.from(before);
  drawBadge(after, SIZE, 0);
  assert.deepEqual(after, before);
});

test("drawBadge paints a red badge with white ink in the bottom-right", () => {
  const buf = blueCanvas();
  drawBadge(buf, SIZE, 3);

  // The top-left corner is far from the badge and stays the base blue.
  assert.deepEqual(px(buf, 0, 0), [0, 0, 255, 255]);

  // A red pixel just right of centre in the red disc body.
  const [r, g, b] = px(buf, 25, 21);
  assert.ok(r > 150 && g < 120 && b < 120, `expected red, got ${[r, g, b]}`);

  // The digit contributes white ink somewhere inside the badge region.
  let whites = 0;
  for (let y = SIZE / 2; y < SIZE; y++) {
    for (let x = SIZE / 2; x < SIZE; x++) {
      const [pr, pg, pb] = px(buf, x, y);
      if (pr > 200 && pg > 200 && pb > 200) whites++;
    }
  }
  assert.ok(whites > 0, "expected white digit pixels in the badge");
});

test("drawBadge caps overflow counts (renders 9+)", () => {
  const buf = blueCanvas();
  drawBadge(buf, SIZE, 42);
  // A red badge is present (the exact glyphs are 9 and +).
  let reds = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] > 150 && buf[i + 1] < 120 && buf[i + 2] < 120) reds++;
  }
  assert.ok(reds > 0, "expected a red badge for an overflow count");
});

// A minimal nativeImage stub: it hands back a BGRA bitmap (the byte order Electron
// uses) and records what createFromBitmap is asked to build.
function fakeNativeImage() {
  const created = [];
  const bgraBlue = () => {
    const buf = Buffer.alloc(SIZE * SIZE * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 255; // B
      buf[i + 1] = 0; // G
      buf[i + 2] = 0; // R
      buf[i + 3] = 255; // A
    }
    return buf;
  };
  const image = () => ({
    isEmpty: () => false,
    resize: () => image(),
    toBitmap: () => bgraBlue(),
  });
  return {
    created,
    createFromPath: () => image(),
    createEmpty: () => ({ isEmpty: () => true }),
    createFromBitmap: (buf, opts) => {
      const img = { buf: Buffer.from(buf), opts };
      created.push(img);
      return img;
    },
  };
}

test("buildTrayImage returns a badge-free @2x icon when nothing is connected", () => {
  const nativeImage = fakeNativeImage();
  const img = buildTrayImage({
    nativeImage,
    colorIconPath: "/icon.png",
    count: 0,
  });
  assert.equal(img.opts.scaleFactor, 2);
  assert.equal(img.opts.width, SIZE);
  // No red channel anywhere (BGRA red lives at index+2) — the plain blue icon.
  let reds = 0;
  for (let i = 0; i < img.buf.length; i += 4) {
    if (img.buf[i + 2] > 150) reds++;
  }
  assert.equal(reds, 0);
});

test("buildTrayImage composites the badge when tunnels are connected", () => {
  const nativeImage = fakeNativeImage();
  const img = buildTrayImage({
    nativeImage,
    colorIconPath: "/icon.png",
    count: 2,
  });
  // The red badge shows up in the BGRA buffer (red at index+2).
  let reds = 0;
  for (let i = 0; i < img.buf.length; i += 4) {
    if (img.buf[i + 2] > 150) reds++;
  }
  assert.ok(reds > 0, "expected red badge pixels in the composited icon");
});

test("buildTrayImage returns the empty image when the icon is missing", () => {
  const nativeImage = fakeNativeImage();
  const img = buildTrayImage({
    nativeImage,
    colorIconPath: undefined,
    count: 1,
  });
  assert.equal(img.isEmpty(), true);
});
