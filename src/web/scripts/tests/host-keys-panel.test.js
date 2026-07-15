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

// host-keys-panel.test.js — the Settings → Host Keys tab: it lists the accepted
// TOFU fingerprints from the bridge, and a per-row forget is a two-step inline
// confirm (single-popup rule) that only calls hostkeys.revoke on the second click,
// then re-pulls the list.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { HostKeysPanel } from "../components/host-keys-panel.js";

// A fake bridge whose list() returns successive pages, so we can assert the panel
// re-pulls after a revoke. `revoke` records its args and returns the store's shape.
function stubBridge({ pages = [[]], revokeResult = { revoked: true } } = {}) {
  const calls = { list: 0, revoke: [] };
  const hostkeys = {
    list: async () => {
      const page = pages[Math.min(calls.list, pages.length - 1)];
      calls.list++;
      return page.map((e) => ({ ...e }));
    },
    revoke: async (hostPort) => {
      calls.revoke.push(hostPort);
      return revokeResult;
    },
  };
  return { porthippo: { hostkeys }, calls };
}

const ENTRY = (hostPort, fingerprint) => ({
  hostPort,
  fingerprint,
  addedAt: 1700000000000,
});

// Flush the microtasks a not-awaited async handler (load / forget) leaves pending.
const tick = () => new Promise((r) => setTimeout(r, 0));

test("load() renders a row per accepted key, sorted by host, with the fingerprint", async () => {
  resetDom();
  const { porthippo } = stubBridge({
    pages: [
      [
        ENTRY("second.example.com:22", "SHA256:bbb"),
        ENTRY("first.example.com:2222", "SHA256:aaa"),
      ],
    ],
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  const rows = panel.element.querySelectorAll(".hostkeys-item");
  assert.equal(rows.length, 2, "one row per entry");
  // Alphabetical by host:port.
  assert.match(rows[0].textContent, /first\.example\.com:2222/);
  assert.match(rows[1].textContent, /second\.example\.com:22/);
  // The fingerprint is shown so the user can identify the key.
  assert.match(rows[0].textContent, /SHA256:aaa/);
});

test("an empty store shows the empty state, no rows", async () => {
  resetDom();
  const { porthippo } = stubBridge({ pages: [[]] });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  assert.equal(panel.element.querySelector(".hostkeys-item"), null);
  assert.ok(
    panel.element.querySelector(".hostkeys-empty"),
    "the empty-state message is shown",
  );
});

test("a rejected list() shows the load-error state, NOT the empty state", async () => {
  resetDom();
  const panel = new HostKeysPanel({
    porthippo: {
      hostkeys: {
        list: async () => {
          throw new Error("bridge down");
        },
      },
    },
  });
  await panel.load(); // must not reject
  assert.ok(
    panel.element.querySelector(".hostkeys-error"),
    "the error state is shown",
  );
  assert.equal(
    panel.element.querySelector(".hostkeys-empty"),
    null,
    "a load failure never masquerades as 'no keys trusted'",
  );
});

test("a missing hostkeys bridge (e.g. stale preload) shows the load-error state", async () => {
  resetDom();
  // No hostkeys.list function at all — the real-world stale-main-process case.
  const panel = new HostKeysPanel({ porthippo: { hostkeys: {} } });
  await panel.load();
  assert.ok(panel.element.querySelector(".hostkeys-error"));
  assert.equal(panel.element.querySelector(".hostkeys-empty"), null);
});

test("Retry re-runs the load and renders the list once it succeeds", async () => {
  resetDom();
  // Fail the first call, then succeed with one entry.
  let attempt = 0;
  const porthippo = {
    hostkeys: {
      list: async () => {
        attempt++;
        if (attempt === 1) throw new Error("transient");
        return [ENTRY("db.example.com:22", "SHA256:abc")];
      },
    },
  };
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();
  assert.ok(
    panel.element.querySelector(".hostkeys-error"),
    "first load errors",
  );

  panel.element.querySelector(".hostkeys-retry").click();
  await tick(); // the async retry → list() → render settles

  assert.equal(panel.element.querySelector(".hostkeys-error"), null);
  assert.equal(
    panel.element.querySelectorAll(".hostkeys-item").length,
    1,
    "the recovered list renders",
  );
});

test("a successful read of an empty store still shows the empty state (not the error)", async () => {
  resetDom();
  const { porthippo } = stubBridge({ pages: [[]] });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();
  assert.ok(panel.element.querySelector(".hostkeys-empty"));
  assert.equal(panel.element.querySelector(".hostkeys-error"), null);
});

test("forget is a two-step inline confirm — the first click only reveals the confirm", async () => {
  resetDom();
  const { porthippo, calls } = stubBridge({
    pages: [[ENTRY("db.example.com:22", "SHA256:abc")]],
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  panel.element.querySelector(".hostkeys-forget").click();

  const item = panel.element.querySelector(".hostkeys-item");
  assert.ok(
    item.classList.contains("hostkeys-item--confirming"),
    "the row enters the confirming state",
  );
  assert.ok(panel.element.querySelector(".hostkeys-confirm-forget"));
  assert.equal(calls.revoke.length, 0, "nothing is revoked until confirmed");
});

test("cancelling the confirm restores the forget button and revokes nothing", async () => {
  resetDom();
  const { porthippo, calls } = stubBridge({
    pages: [[ENTRY("db.example.com:22", "SHA256:abc")]],
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  panel.element.querySelector(".hostkeys-forget").click();
  panel.element.querySelector(".hostkeys-confirm-cancel").click();

  const item = panel.element.querySelector(".hostkeys-item");
  assert.equal(item.classList.contains("hostkeys-item--confirming"), false);
  assert.ok(panel.element.querySelector(".hostkeys-forget"), "button is back");
  assert.equal(calls.revoke.length, 0);
});

test("confirming forget calls revoke with the host:port and re-pulls the list", async () => {
  resetDom();
  // First page has the entry; after the revoke the store is empty.
  const { porthippo, calls } = stubBridge({
    pages: [[ENTRY("db.example.com:22", "SHA256:abc")], []],
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  panel.element.querySelector(".hostkeys-forget").click();
  panel.element.querySelector(".hostkeys-confirm-forget").click();
  await tick(); // the async #forget → revoke → load() chain settles

  assert.deepEqual(calls.revoke, ["db.example.com:22"]);
  assert.equal(
    calls.list,
    2,
    "the list is re-pulled after a successful revoke",
  );
  assert.equal(
    panel.element.querySelector(".hostkeys-item"),
    null,
    "the forgotten row is gone",
  );
  assert.ok(panel.element.querySelector(".hostkeys-empty"));
});

test("a revoke that returns a write-error envelope leaves the row in place", async () => {
  resetDom();
  const { porthippo, calls } = stubBridge({
    pages: [[ENTRY("db.example.com:22", "SHA256:abc")], []],
    revokeResult: { __hippoError: true },
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();

  panel.element.querySelector(".hostkeys-forget").click();
  panel.element.querySelector(".hostkeys-confirm-forget").click();
  await tick();

  assert.deepEqual(calls.revoke, ["db.example.com:22"]);
  assert.equal(calls.list, 1, "no re-pull on a failed revoke");
  assert.ok(
    panel.element.querySelector(".hostkeys-item"),
    "the row (and its forget affordance) remain for a retry",
  );
});
