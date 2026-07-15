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

// card-catalog.js — the shared metric catalogue used by BOTH the per-tunnel
// detail cards (TunnelDetail) and the all-tunnels list (TunnelTable). Each entry
// maps a stats snapshot (+ now + live state) to a display string via `value(ctx)`
// and to a comparable via `sortValue(ctx)` (so the list can sort a column). The
// visible set + its order are persisted by the owner in settings (`cardOrder`)
// and shared between the two views, so a card that is a detail card is also a
// list column, in the same order. The pure helpers here are unit-tested directly.

import { t } from "../i18n.js";
import {
  formatRate,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from "../utils/format.js";

/** Coerce a possibly-missing numeric field to a number for sorting. */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Average bytes/sec over the armed lifetime: total bytes ÷ time since `armedAt`.
 * Zero when the tunnel isn't armed or no time has elapsed (avoids a divide-by-
 * zero and a meaningless spike on the first tick). Used by the "Average
 * throughput" card for both its value and its sort key.
 */
function avgRate(c) {
  const armedAt = c.snap?.armedAt;
  if (!armedAt) return 0;
  const elapsedS = (c.now - armedAt) / 1000;
  if (!(elapsedS > 0)) return 0;
  return Math.round(num(c.snap?.totalBytes) / elapsedS);
}

// A meaningful sort order for the (non-numeric) State column: quietest → busiest.
const STATE_RANK = {
  disarmed: 0,
  error: 1,
  paused: 2,
  listening: 3,
  connecting: 4,
  connected: 5,
};

// The selector groups its checklist under these categories. Keys map to an i18n
// label; the menu orders the categories alphabetically by that label (and the
// cards within each alphabetically too), so the grouping stays stable per locale.
export const CATEGORIES = {
  throughput: "card.category.throughput",
  transfer: "card.category.transfer",
  connections: "card.category.connections",
  status: "card.category.status",
  activity: "card.category.activity",
};

// The card/column catalogue. `value(ctx)` maps a snapshot to a display string;
// `sortValue(ctx)` maps it to a comparable (number, or the state rank); `tone` /
// `toneFn` / `stateTone` colour the value; `category` groups it in the selector.
// Order here is the DEFAULT display order (the selector re-groups + sorts it).
export const CARDS = [
  {
    key: "download",
    labelKey: "card.download",
    category: "throughput",
    tone: "down",
    value: (c) => formatRate(c.snap?.rateDown ?? 0),
    sortValue: (c) => num(c.snap?.rateDown),
  },
  {
    key: "peakDownload",
    labelKey: "card.peakDownload",
    category: "throughput",
    tone: "down",
    value: (c) => formatRate(c.snap?.peakRateDown ?? 0),
    sortValue: (c) => num(c.snap?.peakRateDown),
  },
  {
    key: "upload",
    labelKey: "card.upload",
    category: "throughput",
    tone: "up",
    value: (c) => formatRate(c.snap?.rateUp ?? 0),
    sortValue: (c) => num(c.snap?.rateUp),
  },
  {
    key: "peakUpload",
    labelKey: "card.peakUpload",
    category: "throughput",
    tone: "up",
    value: (c) => formatRate(c.snap?.peakRateUp ?? 0),
    sortValue: (c) => num(c.snap?.peakRateUp),
  },
  {
    key: "combinedThroughput",
    labelKey: "card.combinedThroughput",
    category: "throughput",
    value: (c) => formatRate(num(c.snap?.rateUp) + num(c.snap?.rateDown)),
    sortValue: (c) => num(c.snap?.rateUp) + num(c.snap?.rateDown),
  },
  {
    key: "avgThroughput",
    labelKey: "card.avgThroughput",
    category: "throughput",
    value: (c) => formatRate(avgRate(c)),
    sortValue: (c) => avgRate(c),
  },
  {
    key: "connections",
    labelKey: "card.connections",
    category: "connections",
    value: (c) => String(c.snap?.activeConnections ?? 0),
    sortValue: (c) => num(c.snap?.activeConnections),
  },
  {
    key: "peakConnections",
    labelKey: "card.peakConnections",
    category: "connections",
    value: (c) => String(c.snap?.peakConnections ?? 0),
    sortValue: (c) => num(c.snap?.peakConnections),
  },
  {
    key: "transferred",
    labelKey: "card.transferred",
    category: "transfer",
    value: (c) => formatBytes(c.snap?.totalBytes ?? 0),
    sortValue: (c) => num(c.snap?.totalBytes),
  },
  {
    key: "openFor",
    labelKey: "card.openFor",
    category: "activity",
    value: (c) =>
      c.snap?.openedAt
        ? formatDuration(c.now - c.snap.openedAt)
        : t("card.none"),
    sortValue: (c) => (c.snap?.openedAt ? c.now - c.snap.openedAt : -1),
  },
  {
    key: "state",
    labelKey: "card.state",
    category: "status",
    stateTone: true,
    value: (c) => t(`state.${c.state}`),
    sortValue: (c) => STATE_RANK[c.state] ?? -1,
  },
  {
    key: "sent",
    labelKey: "card.sent",
    category: "transfer",
    value: (c) => formatBytes(c.snap?.bytesUp ?? 0),
    sortValue: (c) => num(c.snap?.bytesUp),
  },
  {
    key: "received",
    labelKey: "card.received",
    category: "transfer",
    value: (c) => formatBytes(c.snap?.bytesDown ?? 0),
    sortValue: (c) => num(c.snap?.bytesDown),
  },
  {
    key: "connectionCount",
    labelKey: "card.connectionCount",
    category: "connections",
    value: (c) => String(c.snap?.connectionCount ?? 0),
    sortValue: (c) => num(c.snap?.connectionCount),
  },
  {
    key: "errors",
    labelKey: "card.errors",
    category: "status",
    toneFn: (c) => ((c.snap?.errorCount ?? 0) > 0 ? "error" : null),
    value: (c) => String(c.snap?.errorCount ?? 0),
    sortValue: (c) => num(c.snap?.errorCount),
  },
  {
    key: "idle",
    labelKey: "card.idle",
    category: "activity",
    value: (c) =>
      c.snap?.lastActiveAt
        ? formatDuration(c.now - c.snap.lastActiveAt)
        : t("card.none"),
    sortValue: (c) => (c.snap?.lastActiveAt ? c.now - c.snap.lastActiveAt : -1),
  },
  {
    key: "firstConnection",
    labelKey: "card.firstConnection",
    category: "activity",
    value: (c) => formatRelativeTime(c.snap?.firstConnectedAt, c.now),
    sortValue: (c) => num(c.snap?.firstConnectedAt),
  },
  {
    key: "lastConnection",
    labelKey: "card.lastConnection",
    category: "activity",
    value: (c) => formatRelativeTime(c.snap?.openedAt, c.now),
    sortValue: (c) => num(c.snap?.openedAt),
  },
  {
    key: "lastDisconnect",
    labelKey: "card.lastDisconnect",
    category: "activity",
    value: (c) => formatRelativeTime(c.snap?.lastDisconnectedAt, c.now),
    sortValue: (c) => num(c.snap?.lastDisconnectedAt),
  },
];

const CARD_BY_KEY = new Map(CARDS.map((cd) => [cd.key, cd]));
export const DEFAULT_CARD_ORDER = CARDS.map((cd) => cd.key);

/** The catalogue entry for a key, or undefined. */
export function getCard(key) {
  return CARD_BY_KEY.get(key);
}

/**
 * The VISIBLE cards, in order, for a saved value. A saved array IS the visible
 * set (unknown keys dropped, de-duped); any valid card absent from it is hidden
 * and available to add. A missing/invalid value is "first run" → every card is
 * shown. An empty array is honoured (the user hid them all).
 */
export function visibleCards(saved) {
  if (!Array.isArray(saved)) return [...DEFAULT_CARD_ORDER];
  const seen = new Set();
  const out = [];
  for (const k of saved) {
    if (CARD_BY_KEY.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/** The cards NOT currently visible, in default order — the "add" list. */
export function hiddenCards(visible) {
  const shown = new Set(visible);
  return DEFAULT_CARD_ORDER.filter((k) => !shown.has(k));
}

/** Label for a card key (for the manage-cards checklist + list headers). */
export function cardLabel(key) {
  const c = CARD_BY_KEY.get(key);
  return c ? t(c.labelKey) : key;
}

/**
 * The catalogue grouped for the selector: every card bucketed by its category,
 * the categories ordered alphabetically by their (localised) label, and the
 * cards within each ordered alphabetically by their (localised) label. Labels
 * resolve through `t()`, so the ordering follows the active locale. A card with
 * no known category falls into an `other` bucket (labelled by its raw key).
 * @returns {Array<{category:string, labelKey:string, keys:string[]}>}
 */
export function cardsByCategory() {
  const buckets = new Map();
  for (const card of CARDS) {
    const cat = card.category || "other";
    if (!buckets.has(cat)) buckets.set(cat, []);
    buckets.get(cat).push(card.key);
  }
  const byLabel = (a, b) =>
    cardLabel(a).localeCompare(cardLabel(b), undefined, { numeric: true });
  const groups = [...buckets.entries()].map(([category, keys]) => ({
    category,
    labelKey: CATEGORIES[category] || category,
    keys: keys.sort(byLabel),
  }));
  groups.sort((a, b) => t(a.labelKey).localeCompare(t(b.labelKey)));
  return groups;
}

/** Move `fromKey` to `toKey`'s slot; pure so it can be unit-tested. */
export function reorderCards(order, fromKey, toKey) {
  if (fromKey === toKey) return [...order];
  const without = order.filter((k) => k !== fromKey);
  const idx = without.indexOf(toKey);
  if (idx === -1) return [...without, fromKey];
  without.splice(idx, 0, fromKey);
  return without;
}

/**
 * The `card-value--*` modifier classes for a card's current value: its static /
 * computed tone plus, for the State card, the live-state tone. Shared so a detail
 * card and a list cell colour identically.
 * @returns {string[]}
 */
export function cardToneClasses(card, ctx) {
  const out = [];
  const tone = card.toneFn ? card.toneFn(ctx) : card.tone;
  if (tone) out.push(`card-value--${tone}`);
  if (card.stateTone) out.push(`card-value--state-${ctx.state}`);
  return out;
}
