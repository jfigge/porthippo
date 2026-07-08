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
 * stats.js — a per-tunnel `Stats` object: the main-process source of truth the
 * Monitoring view (Feature 50) renders. The relay feeds it byte counts and
 * connection open/close events; the tunnel feeds it arm / SSH-connect /
 * SSH-disconnect lifecycle events. `snapshot()` returns a plain, serializable
 * object the engine streams to the renderer over `porthippo:stats`.
 *
 * Semantics (settled in the Feature 30 plan):
 *   - **Totals** (`bytesUp` / `bytesDown`) are monotonic counters, cumulative
 *     since the current arm; they never decrease and survive an idle SSH
 *     teardown + reconnect. A fresh `onArmed()` zeroes them.
 *   - **Rates** are a rolling measurement over a short sliding window of fixed
 *     buckets, so the displayed value is stable and decays to zero shortly after
 *     traffic stops (rather than being an instantaneous spike).
 *   - **`openedAt`** = ms epoch the *current* SSH session connected (null when
 *     not connected); it resets on every teardown/reconnect. **`armedAt`** = ms
 *     epoch the listener was (re)armed. **`lastActiveAt`** = ms epoch of the last
 *     byte in either direction.
 *
 * Pure and unit-testable: all time comes from an injected `now()` clock, so the
 * rolling-rate math can be exercised with a fake clock and no real timers.
 */
"use strict";

// Rolling-rate window: sum the bytes seen in the last RATE_WINDOW_MS, bucketed at
// RATE_BUCKET_MS granularity, and divide by the window length to get bytes/sec.
// A few short buckets keep the rate responsive yet smooth; when traffic stops the
// buckets age out and the rate falls to zero within one window.
const RATE_WINDOW_MS = 3000;
const RATE_BUCKET_MS = 500;
const RATE_BUCKET_COUNT = RATE_WINDOW_MS / RATE_BUCKET_MS;

class Stats {
  #now;
  #buckets = []; // [{ idx, up, down }] within the window, oldest first

  // Public, serializable fields (mirrored verbatim into snapshot()).
  bytesUp = 0;
  bytesDown = 0;
  activeConnections = 0;
  lastActiveAt = null;
  openedAt = null;
  armedAt = null;

  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now]  injected clock (ms epoch); defaults to Date.now
   */
  constructor({ now } = {}) {
    this.#now = now || Date.now;
  }

  // ── Byte counters (called by relay.js) ──────────────────────────────────────

  /** Count `n` bytes sent client → destination. */
  addUp(n) {
    this.#add("up", n);
  }

  /** Count `n` bytes received destination → client. */
  addDown(n) {
    this.#add("down", n);
  }

  #add(dir, n) {
    if (!(n > 0)) return;
    if (dir === "up") this.bytesUp += n;
    else this.bytesDown += n;

    const idx = this.#curIdx();
    let bucket = this.#buckets[this.#buckets.length - 1];
    if (!bucket || bucket.idx !== idx) {
      bucket = { idx, up: 0, down: 0 };
      this.#buckets.push(bucket);
    }
    bucket[dir] += n;
    this.#prune(idx);
    this.lastActiveAt = this.#now();
  }

  // ── Connection counting (called by relay.js on relay open/close) ────────────

  /** A relay's forwarded channel opened. */
  connOpened() {
    this.activeConnections += 1;
  }

  /** A relay closed. */
  connClosed() {
    if (this.activeConnections > 0) this.activeConnections -= 1;
  }

  // ── Lifecycle (called by tunnel.js) ─────────────────────────────────────────

  /** The listener was (re)armed — start a fresh, zeroed measurement session. */
  onArmed() {
    this.bytesUp = 0;
    this.bytesDown = 0;
    this.activeConnections = 0;
    this.lastActiveAt = null;
    this.openedAt = null;
    this.armedAt = this.#now();
    this.#buckets = [];
  }

  /** The SSH session connected — stamp the current open time. */
  onConnected() {
    this.openedAt = this.#now();
  }

  /** The SSH session was torn down (idle linger, drop, or reconnect boundary). */
  onDisconnected() {
    this.openedAt = null;
    this.#buckets = []; // no live session → rates read zero immediately
  }

  /** The tunnel was disarmed — clear session markers; totals freeze at last value. */
  onDisarmed() {
    this.openedAt = null;
    this.armedAt = null;
    this.#buckets = [];
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────

  /** A plain, serializable view of the current metrics (no live handles). */
  snapshot() {
    this.#prune(this.#curIdx());
    let up = 0;
    let down = 0;
    for (const bucket of this.#buckets) {
      up += bucket.up;
      down += bucket.down;
    }
    const perSec = RATE_WINDOW_MS / 1000;
    return {
      activeConnections: this.activeConnections,
      bytesUp: this.bytesUp,
      bytesDown: this.bytesDown,
      totalBytes: this.bytesUp + this.bytesDown,
      rateUp: Math.round(up / perSec),
      rateDown: Math.round(down / perSec),
      openedAt: this.openedAt,
      armedAt: this.armedAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  // ── Rolling-window internals ────────────────────────────────────────────────

  #curIdx() {
    return Math.floor(this.#now() / RATE_BUCKET_MS);
  }

  /** Drop buckets that have aged out of the window ending at `idx`. */
  #prune(idx) {
    const cutoff = idx - RATE_BUCKET_COUNT + 1;
    while (this.#buckets.length && this.#buckets[0].idx < cutoff) {
      this.#buckets.shift();
    }
  }
}

module.exports = { Stats };
