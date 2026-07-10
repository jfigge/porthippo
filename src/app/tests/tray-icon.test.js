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

const { buildTrayImage, drawHippo, drawBadge, SIZE } = require("../tray-icon");

// Alpha channel of a pixel in a premultiplied-RGBA buffer.
const alpha = (buf, x, y) => buf[(y * SIZE + x) * 4 + 3];

// Map a point in the 512×512 viewBox to canvas-pixel space, mirroring drawHippo's
// own transform so tests can probe known features (eyes, corners).
function toCanvas(vx, vy) {
  const margin = SIZE * 0.05;
  const scale = (SIZE - 2 * margin) / 304; // VB_HEIGHT
  return [
    Math.round((vx - 256) * scale + SIZE / 2),
    Math.round((vy - 258) * scale + SIZE / 2),
  ];
}

test("drawHippo fills the body and leaves the surround transparent", () => {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  drawHippo(buf, SIZE);

  // Some of the canvas is opaque hippo, but not all of it.
  let opaque = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 200) opaque++;
  assert.ok(opaque > 0, "expected opaque hippo pixels");
  assert.ok(opaque < SIZE * SIZE, "expected transparent surround");

  // The far corners sit outside the hippo bounding box → transparent.
  assert.equal(alpha(buf, 0, 0), 0);
  assert.equal(alpha(buf, SIZE - 1, 0), 0);

  // The image is pure black: only the alpha channel is ever set.
  for (let i = 0; i < buf.length; i += 4) {
    assert.equal(buf[i], 0);
    assert.equal(buf[i + 1], 0);
    assert.equal(buf[i + 2], 0);
  }
});

test("drawHippo punches the eyes out as transparent holes", () => {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  drawHippo(buf, SIZE);

  // The forehead between the eyes is solid body...
  const [fx, fy] = toCanvas(256, 175);
  assert.ok(alpha(buf, fx, fy) > 200, "expected an opaque forehead");

  // ...while each eye centre is cut clear (or nearly so).
  const [lx, ly] = toCanvas(201, 198);
  const [rx, ry] = toCanvas(311, 198);
  assert.ok(alpha(buf, lx, ly) < 128, "expected the left eye to be a hole");
  assert.ok(alpha(buf, rx, ry) < 128, "expected the right eye to be a hole");
});

test("drawBadge leaves the buffer untouched when the count is zero", () => {
  const before = drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE);
  const after = Buffer.from(before);
  drawBadge(after, SIZE, 0);
  assert.deepEqual(after, before);
});

test("drawBadge paints a moated disc with punched-out digits (still pure black)", () => {
  const buf = drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE);
  drawBadge(buf, SIZE, 3);

  // The disc body near the bottom-right corner is opaque.
  const r = SIZE * 0.32;
  const cx = Math.round(SIZE - r - 1);
  const cy = Math.round(SIZE - r - 1);
  assert.ok(alpha(buf, cx, cy - 3) > 200, "expected an opaque badge disc");

  // The digit contributes transparent (punched-out) pixels inside the disc.
  let holes = 0;
  for (let y = SIZE / 2; y < SIZE; y++) {
    for (let x = SIZE / 2; x < SIZE; x++) {
      if (alpha(buf, x, y) === 0) holes++;
    }
  }
  assert.ok(holes > 0, "expected transparent digit holes in the badge");

  // No colour is ever introduced — the badge is alpha-only black.
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] || buf[i + 1] || buf[i + 2]) {
      assert.fail("badge introduced a non-black pixel");
    }
  }
});

test("drawBadge caps overflow counts (renders 9+)", () => {
  const nine = drawBadge(
    drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE),
    SIZE,
    9,
  );
  const over = drawBadge(
    drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE),
    SIZE,
    42,
  );
  // "42" is clamped to "9+", so its punched digits differ from a plain "9".
  assert.notDeepEqual(over, nine);
});

// A minimal nativeImage stub: it records what createFromBitmap is asked to build
// and whether the result was flagged as a template.
function fakeNativeImage() {
  const created = [];
  return {
    created,
    createFromBitmap: (buf, opts) => {
      const img = {
        buf: Buffer.from(buf),
        opts,
        template: false,
        setTemplateImage(v) {
          this.template = v;
        },
      };
      created.push(img);
      return img;
    },
  };
}

test("buildTrayImage returns a badge-free @2x hippo when nothing is connected", () => {
  const nativeImage = fakeNativeImage();
  const img = buildTrayImage({ nativeImage, count: 0 });
  assert.equal(img.opts.scaleFactor, 2);
  assert.equal(img.opts.width, SIZE);

  // Opaque hippo pixels are present; the badge (no digit holes surrounded by an
  // opaque disc) is absent because the count is zero.
  const plain = drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE);
  assert.deepEqual(img.buf, plain);
});

test("buildTrayImage composites the badge when tunnels are connected", () => {
  const nativeImage = fakeNativeImage();
  const img = buildTrayImage({ nativeImage, count: 2 });
  const plain = drawHippo(Buffer.alloc(SIZE * SIZE * 4), SIZE);
  assert.notDeepEqual(img.buf, plain);
});

test("buildTrayImage flags a template image only when asked", () => {
  const withTemplate = buildTrayImage({
    nativeImage: fakeNativeImage(),
    template: true,
  });
  const withoutTemplate = buildTrayImage({
    nativeImage: fakeNativeImage(),
    template: false,
  });
  assert.equal(withTemplate.template, true);
  assert.equal(withoutTemplate.template, false);
});
