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

// format.js — pure, unit-tested display formatters for the Feature 50 Monitoring
// view. The renderer is a pure subscriber of the `porthippo:stats` stream (all
// numbers come from main); these functions only turn those raw bytes/timestamps
// into human units. Kept free of DOM and time-of-day side effects: the one
// now-dependent function takes an injected `now` so the relative-time math is
// deterministic under test. When Feature 60's i18n lands, these route through
// `formatNumber`/`formatDate` — callers already go through this seam.

const KIB = 1024;
const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB"];

/**
 * A byte count in human units: `0 B`, `512 B`, `1.5 KB`, `6.0 MB`, `2.3 GB`.
 * Base-1024; sub-kilobyte values are whole bytes, larger ones carry one decimal.
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < KIB) {
    return `${Math.max(0, Math.round(Number.isFinite(n) ? n : 0))} B`;
  }
  let value = n / KIB;
  let i = 0;
  while (value >= KIB && i < BYTE_UNITS.length - 1) {
    value /= KIB;
    i += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[i]}`;
}

/**
 * A transfer rate: a byte count per second, e.g. `12.5 KB/s`, `0 B/s`.
 * @param {number} bytesPerSecond
 * @returns {string}
 */
export function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * A duration in ms as a compact two-unit string: `0s`, `45s`, `4m 12s`,
 * `1h 3m`, `2d 4h`. Always the two largest non-zero units (or just seconds).
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  let secs = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(secs) || secs < 0) secs = 0;
  const days = Math.floor(secs / 86400);
  secs -= days * 86400;
  const hours = Math.floor(secs / 3600);
  secs -= hours * 3600;
  const mins = Math.floor(secs / 60);
  secs -= mins * 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${mins}m`;
  if (mins) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

/**
 * A past instant as a coarse relative label: `just now`, `3s ago`, `5m ago`,
 * `2h ago`, `4d ago`. Null/undefined → `never`; a future instant → `just now`.
 * @param {number|null|undefined} then  ms epoch of the past instant
 * @param {number} [now]  injected clock (ms epoch) — defaults to Date.now()
 * @returns {string}
 */
export function formatRelativeTime(then, now = Date.now()) {
  if (then == null || !Number.isFinite(Number(then))) return "never";
  const deltaS = Math.floor((now - Number(then)) / 1000);
  if (deltaS < 1) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const mins = Math.floor(deltaS / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
