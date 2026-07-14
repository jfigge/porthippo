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

// A meaningful sort order for the (non-numeric) State column: quietest → busiest.
const STATE_RANK = {
  disarmed: 0,
  error: 1,
  paused: 2,
  listening: 3,
  connecting: 4,
  connected: 5,
};

// The card/column catalogue. `value(ctx)` maps a snapshot to a display string;
// `sortValue(ctx)` maps it to a comparable (number, or the state rank); `tone` /
// `toneFn` / `stateTone` colour the value. Order here is the DEFAULT order.
export const CARDS = [
  {
    key: "download",
    labelKey: "card.download",
    tone: "down",
    value: (c) => formatRate(c.snap?.rateDown ?? 0),
    sortValue: (c) => num(c.snap?.rateDown),
  },
  {
    key: "upload",
    labelKey: "card.upload",
    tone: "up",
    value: (c) => formatRate(c.snap?.rateUp ?? 0),
    sortValue: (c) => num(c.snap?.rateUp),
  },
  {
    key: "connections",
    labelKey: "card.connections",
    value: (c) => String(c.snap?.activeConnections ?? 0),
    sortValue: (c) => num(c.snap?.activeConnections),
  },
  {
    key: "transferred",
    labelKey: "card.transferred",
    value: (c) => formatBytes(c.snap?.totalBytes ?? 0),
    sortValue: (c) => num(c.snap?.totalBytes),
  },
  {
    key: "openFor",
    labelKey: "card.openFor",
    value: (c) =>
      c.snap?.openedAt
        ? formatDuration(c.now - c.snap.openedAt)
        : t("card.none"),
    sortValue: (c) => (c.snap?.openedAt ? c.now - c.snap.openedAt : -1),
  },
  {
    key: "state",
    labelKey: "card.state",
    stateTone: true,
    value: (c) => t(`state.${c.state}`),
    sortValue: (c) => STATE_RANK[c.state] ?? -1,
  },
  {
    key: "sent",
    labelKey: "card.sent",
    value: (c) => formatBytes(c.snap?.bytesUp ?? 0),
    sortValue: (c) => num(c.snap?.bytesUp),
  },
  {
    key: "received",
    labelKey: "card.received",
    value: (c) => formatBytes(c.snap?.bytesDown ?? 0),
    sortValue: (c) => num(c.snap?.bytesDown),
  },
  {
    key: "connectionCount",
    labelKey: "card.connectionCount",
    value: (c) => String(c.snap?.connectionCount ?? 0),
    sortValue: (c) => num(c.snap?.connectionCount),
  },
  {
    key: "errors",
    labelKey: "card.errors",
    toneFn: (c) => ((c.snap?.errorCount ?? 0) > 0 ? "error" : null),
    value: (c) => String(c.snap?.errorCount ?? 0),
    sortValue: (c) => num(c.snap?.errorCount),
  },
  {
    key: "idle",
    labelKey: "card.idle",
    value: (c) =>
      c.snap?.lastActiveAt
        ? formatDuration(c.now - c.snap.lastActiveAt)
        : t("card.none"),
    sortValue: (c) => (c.snap?.lastActiveAt ? c.now - c.snap.lastActiveAt : -1),
  },
  {
    key: "firstConnection",
    labelKey: "card.firstConnection",
    value: (c) => formatRelativeTime(c.snap?.firstConnectedAt, c.now),
    sortValue: (c) => num(c.snap?.firstConnectedAt),
  },
  {
    key: "lastConnection",
    labelKey: "card.lastConnection",
    value: (c) => formatRelativeTime(c.snap?.openedAt, c.now),
    sortValue: (c) => num(c.snap?.openedAt),
  },
  {
    key: "lastDisconnect",
    labelKey: "card.lastDisconnect",
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
