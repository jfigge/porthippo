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
 * notifications.js — desktop notifications for connection-health events
 * (Feature 130). A pure payload builder plus a small coalescing state machine,
 * fed by the same engine `porthippo:tunnel-state` broadcast that updates the tray.
 *
 * Like tray.js, every Electron collaborator is injected (the `Notification` class,
 * a label resolver, a live settings reader, a name resolver, a focus action), so
 * main owns the native surface and this module stays testable headless.
 *
 * SECURITY — a notification carries the tunnel NAME only, never a host, username,
 * SSH server or secret. `notificationFor` (the pure builder) is handed only the
 * name; the caller resolves it from the tunnel id, so no host/credential ever
 * reaches this file. (Covered by notifications.test.js.)
 *
 * Coalescing rules:
 *   - dropped   → at most one notice per tunnel per `notifyCooldownMs` (flap guard).
 *   - recovered → only when a `dropped` notice was actually shown for that tunnel.
 *   - gave-up   → always (bypasses the cooldown) — the terminal, actionable event.
 *   - hostkey-changed → always (a security alert); bypasses the per-event toggles.
 * Each is additionally gated by the master `notificationsEnabled` switch and its
 * per-event toggle, and the OS is trusted to honour Do-Not-Disturb.
 */
"use strict";

/**
 * The (title, body) for one health event, using the tunnel NAME only. Pure and
 * secret-free — exported so a test can assert no host/secret can appear.
 *
 * @param {"dropped"|"recovered"|"gave-up"|"hostkey-changed"} type
 * @param {string} name  the tunnel's display name
 * @param {(key: string, params?: object) => string} t  interpolating resolver
 * @returns {{ title: string, body: string }}
 */
function notificationFor(type, name, t) {
  const safeName = name || t("def.unnamed", "Untitled tunnel");
  switch (type) {
    case "dropped":
      return {
        title: t("notify.dropped.title"),
        body: t("notify.dropped.body", { name: safeName }),
      };
    case "recovered":
      return {
        title: t("notify.recovered.title"),
        body: t("notify.recovered.body", { name: safeName }),
      };
    case "gave-up":
      return {
        title: t("notify.gaveUp.title"),
        body: t("notify.gaveUp.body", { name: safeName }),
      };
    case "hostkey-changed":
      return {
        title: t("notify.hostkeyChanged.title"),
        body: t("notify.hostkeyChanged.body", { name: safeName }),
      };
    default:
      return { title: "", body: "" };
  }
}

/**
 * @param {object} deps
 * @param {typeof Electron.Notification} deps.Notification  the native class
 * @param {(key: string, params?: object) => string} deps.t  label resolver
 * @param {() => object} deps.getSettings  live settings (notify prefs)
 * @param {(id: string) => string} deps.resolveName  tunnel id → display name
 * @param {() => void} [deps.focusWindow]  invoked when a notification is clicked
 * @param {() => number} [deps.now]  injected clock (ms epoch; tests)
 */
function createNotifications({
  Notification,
  t,
  getSettings,
  resolveName,
  focusWindow,
  now = () => Date.now(),
}) {
  // Per-tunnel coalescing state: when the last drop notice was shown (cooldown)
  // and whether a drop notice is currently "open" (so recovered can be gated on it).
  const lastDropAt = new Map(); // id → ms
  const dropShown = new Set(); // ids with an un-recovered drop notice

  function settings() {
    try {
      return getSettings?.() || {};
    } catch {
      return {};
    }
  }

  /** Master switch: nothing shows when it's off. */
  function enabled() {
    return settings().notificationsEnabled !== false;
  }

  function show(type, name) {
    if (!Notification) return null;
    if (
      typeof Notification.isSupported === "function" &&
      !Notification.isSupported()
    ) {
      return null;
    }
    const { title, body } = notificationFor(type, name, t);
    if (!title && !body) return null;
    try {
      const n = new Notification({ title, body });
      if (typeof n.on === "function") n.on("click", () => focusWindow?.());
      if (typeof n.show === "function") n.show();
      return n;
    } catch {
      // Notifications are best-effort; never let one failing take down a broadcast.
      return null;
    }
  }

  /**
   * React to a `porthippo:tunnel-state` snapshot. Only the one-shot `transition`
   * drives a notification; a plain state change (or a stats heartbeat) is ignored.
   */
  function onTunnelState(snapshot) {
    if (!snapshot || !snapshot.id) return;
    const id = snapshot.id;
    if (snapshot.removed) {
      forget(id);
      return;
    }
    const transition = snapshot.transition;
    if (!transition) return;
    const s = settings();

    if (transition === "dropped") {
      if (!enabled() || s.notifyOnDrop === false) return;
      const cooldown = coolMs(s.notifyCooldownMs);
      const last = lastDropAt.get(id);
      // `undefined` = never dropped before → always show the first notice (a t=0
      // clock must not read as "just dropped"). A recorded time gates the flap.
      if (last !== undefined && now() - last < cooldown) return;
      lastDropAt.set(id, now());
      dropShown.add(id);
      show("dropped", resolveName?.(id));
      return;
    }

    if (transition === "recovered") {
      const wasShown = dropShown.delete(id); // the drop episode is over either way
      if (!wasShown) return; // only chirp recovery if we announced the drop
      if (!enabled() || s.notifyOnRecover === false) return;
      show("recovered", resolveName?.(id));
      return;
    }

    if (transition === "gave-up") {
      dropShown.delete(id); // terminal — no recovery to pair with
      if (!enabled() || s.notifyOnGiveUp === false) return;
      show("gave-up", resolveName?.(id)); // always (no cooldown) when enabled
      return;
    }
  }

  /**
   * React to a `porthippo:hostkey-changed` broadcast: a host's key changed since
   * we last trusted it (the connection was refused). A security alert — always
   * shown when notifications are enabled, using the tunnel name only.
   */
  function onHostKeyChanged(info) {
    if (!enabled()) return;
    const id = info && info.tunnelId;
    show("hostkey-changed", id ? resolveName?.(id) : undefined);
  }

  /** Drop a tunnel's coalescing state (it was disarmed / deleted). */
  function forget(id) {
    lastDropAt.delete(id);
    dropShown.delete(id);
  }

  return { onTunnelState, onHostKeyChanged, forget };
}

/** Normalise the cooldown to a non-negative number (default 60s). */
function coolMs(v) {
  return Number.isFinite(v) && v >= 0 ? v : 60000;
}

module.exports = { createNotifications, notificationFor };
