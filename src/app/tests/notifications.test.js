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
 * notifications.test.js — the Feature 130 health-notification coalescing rules and
 * the secret-free payload guarantee. No Electron: the `Notification` class, clock,
 * settings and name resolver are all injected fakes.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createNotifications, notificationFor } = require("../notifications");
const { redact } = require("../diagnostics");

// A recording stand-in for Electron's Notification. Each instance captures its
// payload and its click handler; the static isSupported() is toggleable.
function makeNotificationClass({ supported = true } = {}) {
  const shown = [];
  class FakeNotification {
    static isSupported() {
      return supported;
    }
    constructor(payload) {
      this.payload = payload;
      this.clicked = null;
      shown.push(this);
    }
    on(event, fn) {
      if (event === "click") this.clicked = fn;
    }
    show() {
      this.shownFlag = true;
    }
  }
  return { FakeNotification, shown };
}

// An interpolating resolver good enough for assertions: "<key>|<name>".
const fakeT = (key, params) =>
  params && params.name ? `${key}|${params.name}` : key;

function setup({ settings = {}, names = {}, supported = true, now } = {}) {
  const { FakeNotification, shown } = makeNotificationClass({ supported });
  let clock = 0;
  const focused = { count: 0 };
  const notifier = createNotifications({
    Notification: FakeNotification,
    t: fakeT,
    getSettings: () => ({ notificationsEnabled: true, ...settings }),
    resolveName: (id) => names[id],
    focusWindow: () => (focused.count += 1),
    now: now || (() => clock),
  });
  return {
    notifier,
    shown,
    focused,
    setClock: (v) => {
      clock = v;
    },
  };
}

test("a drop transition shows one notification carrying the tunnel name", () => {
  const { notifier, shown } = setup({ names: { t1: "Prod DB" } });
  notifier.onTunnelState({
    id: "t1",
    state: "connecting",
    transition: "dropped",
  });
  assert.equal(shown.length, 1);
  assert.match(shown[0].payload.body, /Prod DB/);
  assert.equal(shown[0].shownFlag, true);
});

test("a plain state change / heartbeat (no transition) never notifies", () => {
  const { notifier, shown } = setup({ names: { t1: "A" } });
  notifier.onTunnelState({ id: "t1", state: "connected" });
  notifier.onTunnelState({ id: "t1", state: "listening" });
  assert.equal(shown.length, 0);
});

test("repeated drops within the cooldown are coalesced to one notice", () => {
  const { notifier, shown, setClock } = setup({
    names: { t1: "A" },
    settings: { notifyCooldownMs: 60000 },
  });
  setClock(0);
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  setClock(30000); // within cooldown
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(shown.length, 1, "the flapping second drop is suppressed");

  setClock(61000); // past the cooldown
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(shown.length, 2, "a drop past the cooldown notifies again");
});

test("recovered notifies only when a drop was shown for that tunnel", () => {
  const { notifier, shown } = setup({ names: { t1: "A" } });
  // No prior drop → recovered is silent.
  notifier.onTunnelState({ id: "t1", transition: "recovered" });
  assert.equal(shown.length, 0);

  // Drop, then recover → the recovery chirps once.
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  notifier.onTunnelState({ id: "t1", transition: "recovered" });
  assert.equal(shown.length, 2);
  assert.match(shown[1].payload.title, /recovered/);

  // A second recover without a fresh drop is silent again.
  notifier.onTunnelState({ id: "t1", transition: "recovered" });
  assert.equal(shown.length, 2);
});

test("gave-up always notifies, bypassing the drop cooldown", () => {
  const { notifier, shown, setClock } = setup({
    names: { t1: "A" },
    settings: { notifyCooldownMs: 60000 },
  });
  setClock(0);
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  setClock(1000); // well within the cooldown
  notifier.onTunnelState({ id: "t1", transition: "gave-up" });
  assert.equal(shown.length, 2);
  assert.match(shown[1].payload.title, /gaveUp|gave/i);
});

test("the master switch off suppresses every health notification", () => {
  const { notifier, shown } = setup({
    names: { t1: "A" },
    settings: { notificationsEnabled: false },
  });
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  notifier.onTunnelState({ id: "t1", transition: "gave-up" });
  notifier.onHostKeyChanged({ tunnelId: "t1" });
  assert.equal(shown.length, 0);
});

test("per-event toggles gate their own event only", () => {
  const { notifier, shown } = setup({
    names: { t1: "A" },
    settings: { notifyOnDrop: false },
  });
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(shown.length, 0, "drop notice off");
  // A drop that wasn't shown means recovered has nothing to pair with → silent.
  notifier.onTunnelState({ id: "t1", transition: "recovered" });
  assert.equal(shown.length, 0);
  // Give-up is a separate toggle, still on.
  notifier.onTunnelState({ id: "t1", transition: "gave-up" });
  assert.equal(shown.length, 1);
});

test("a host-key change always notifies (name only) regardless of per-event toggles", () => {
  const { notifier, shown } = setup({
    names: { t1: "Bastion route" },
    settings: { notifyOnDrop: false, notifyOnRecover: false },
  });
  notifier.onHostKeyChanged({
    tunnelId: "t1",
    // These host/fingerprint fields must NEVER reach the notification text.
    host: "secret-host.internal",
    port: 22,
    fingerprint: "SHA256:abc",
  });
  assert.equal(shown.length, 1);
  const text = `${shown[0].payload.title} ${shown[0].payload.body}`;
  assert.match(text, /Bastion route/);
  assert.doesNotMatch(text, /secret-host\.internal/);
  assert.doesNotMatch(text, /SHA256/);
});

test("notification text carries the tunnel name only — never a host or secret", () => {
  // Even when the broadcast snapshot carries host-ish fields (it never should),
  // the notifier reads only id + transition, so nothing but the name can appear.
  const { notifier, shown } = setup({ names: { t1: "My Tunnel" } });
  notifier.onTunnelState({
    id: "t1",
    transition: "dropped",
    host: "db.internal",
    user: "root",
    password: "hunter2",
    error: "connect ECONNREFUSED db.internal:5432",
  });
  assert.equal(shown.length, 1);
  const text = `${shown[0].payload.title} ${shown[0].payload.body}`;
  assert.match(text, /My Tunnel/);
  for (const secret of ["db.internal", "root", "hunter2", "ECONNREFUSED"]) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
});

test("the pure builder accepts only a name — its output is structurally secret-free", () => {
  for (const type of ["dropped", "recovered", "gave-up", "hostkey-changed"]) {
    const { title, body } = notificationFor(type, "Alpha", fakeT);
    assert.match(`${title} ${body}`, /Alpha/, `${type} carries the name`);
  }
  // An unknown type yields empty strings (nothing is shown for it).
  assert.deepEqual(notificationFor("nope", "Alpha", fakeT), {
    title: "",
    body: "",
  });
});

test("notification text is inert under the diagnostics redactor (no secret shapes)", () => {
  // The redactor scrubs PEM keys, password:/token: pairs and URL creds. A built
  // notification (name only) must contain none of those shapes, so redact() is a
  // no-op over it — a defense-in-depth confirmation of the secret-free guarantee.
  for (const type of ["dropped", "recovered", "gave-up", "hostkey-changed"]) {
    const { title, body } = notificationFor(type, "Prod database", fakeT);
    const text = `${title} ${body}`;
    assert.equal(
      redact(text),
      text,
      `${type} text survives redact() unchanged`,
    );
  }
});

test("clicking a notification focuses the window", () => {
  const { notifier, shown, focused } = setup({ names: { t1: "A" } });
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(typeof shown[0].clicked, "function");
  shown[0].clicked();
  assert.equal(focused.count, 1);
});

test("when the OS reports notifications unsupported, nothing is shown", () => {
  const { notifier, shown } = setup({ names: { t1: "A" }, supported: false });
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(shown.length, 0);
});

test("forgetting a tunnel (removed) clears its coalescing state", () => {
  const { notifier, shown } = setup({ names: { t1: "A" } });
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  notifier.onTunnelState({ id: "t1", removed: true }); // disarmed / deleted
  // A fresh drop after removal notifies again (cooldown state was cleared).
  notifier.onTunnelState({ id: "t1", transition: "dropped" });
  assert.equal(shown.length, 2);
  // And a recover now has no shown-drop to pair with (state was reset), unless the
  // fresh drop above set it — which it did, so a recover chirps.
  notifier.onTunnelState({ id: "t1", transition: "recovered" });
  assert.equal(shown.length, 3);
});
