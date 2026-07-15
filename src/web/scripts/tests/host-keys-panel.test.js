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

// host-keys-panel.test.js — the Settings → Host Keys tab. Two sub-tabs: "Port
// Hippo" (the accepted TOFU fingerprints, manageable — a per-row forget is a
// two-step inline confirm, single-popup rule, that only calls hostkeys.revoke on
// the second click, then re-pulls) and "Operating System" (~/.ssh/known_hosts,
// read-only — no forget, with a reference to where the file lives).

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { HostKeysPanel } from "../components/host-keys-panel.js";

// A fake bridge whose list() returns successive pages, so we can assert the panel
// re-pulls after a revoke. `revoke` records its args and returns the store's shape.
// Pass `os` (an object or a thunk) to also expose listOs() for the OS sub-tab.
function stubBridge({
  pages = [[]],
  revokeResult = { revoked: true },
  os,
} = {}) {
  const calls = { list: 0, revoke: [], listOs: 0 };
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
  if (os !== undefined) {
    hostkeys.listOs = async () => {
      calls.listOs++;
      return typeof os === "function" ? os() : os;
    };
  }
  return { porthippo: { hostkeys }, calls };
}

const OS_DATA = {
  path: "/home/u/.ssh/known_hosts",
  entries: [
    { host: "github.com", fingerprint: "SHA256:os1", keyType: "ssh-ed25519" },
    // A hashed host: OpenSSH can't reverse it, so host is null.
    { host: null, fingerprint: "SHA256:os2", keyType: "ssh-rsa" },
  ],
};

const osTab = (panel) =>
  panel.element.querySelector('.hostkeys-tab[data-tab="os"]');
const porthippoTab = (panel) =>
  panel.element.querySelector('.hostkeys-tab[data-tab="porthippo"]');

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

// ── Sub-tabs: Port Hippo (managed) vs Operating System (read-only) ────────────

test("renders two sub-tabs, Port Hippo active by default", async () => {
  resetDom();
  const { porthippo } = stubBridge({ pages: [[]], os: OS_DATA });
  const panel = new HostKeysPanel({ porthippo });
  const tabs = panel.element.querySelectorAll(".hostkeys-tab");
  assert.equal(tabs.length, 2, "a Port Hippo and an Operating System tab");
  const active = panel.element.querySelector(".hostkeys-tab--active");
  assert.equal(active.dataset.tab, "porthippo", "Port Hippo is active first");
});

test("the OS tab lists read-only known_hosts with a path reference", async () => {
  resetDom();
  const { porthippo, calls } = stubBridge({ pages: [[]], os: OS_DATA });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load(); // Port Hippo tab first

  osTab(panel).click();
  await tick();

  assert.equal(calls.listOs, 1, "the OS inventory was pulled");
  // The reference to where the OS keys live is shown.
  const pathEl = panel.element.querySelector(".hostkeys-os-path");
  assert.ok(pathEl, "the known_hosts path reference is shown");
  assert.match(pathEl.textContent, /known_hosts/);
  // Two rows, but NONE offer a forget action (read-only).
  assert.equal(panel.element.querySelectorAll(".hostkeys-item").length, 2);
  assert.equal(
    panel.element.querySelector(".hostkeys-forget"),
    null,
    "OS keys can't be managed by Port Hippo",
  );
  // The named host, its fingerprint, and the key type all show.
  assert.match(panel.element.textContent, /github\.com/);
  assert.match(panel.element.textContent, /SHA256:os1/);
  assert.match(panel.element.textContent, /ssh-ed25519/);
});

test("a hashed OS host shows the placeholder instead of a hostname", async () => {
  resetDom();
  const { porthippo } = stubBridge({ pages: [[]], os: OS_DATA });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();
  osTab(panel).click();
  await tick();

  const hosts = [...panel.element.querySelectorAll(".hostkeys-host")].map(
    (n) => n.textContent,
  );
  assert.ok(
    hosts.some((h) => /hashed/i.test(h)),
    "the null-host (hashed) entry renders a placeholder",
  );
});

test("the OS tab shows its own empty state, keeping the path reference", async () => {
  resetDom();
  const { porthippo } = stubBridge({
    pages: [[]],
    os: { path: "/x/known_hosts", entries: [] },
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load();
  osTab(panel).click();
  await tick();

  assert.ok(panel.element.querySelector(".hostkeys-empty"));
  assert.equal(panel.element.querySelector(".hostkeys-item"), null);
  assert.ok(
    panel.element.querySelector(".hostkeys-os-path"),
    "the path reference shows even with no keys",
  );
});

test("a rejected listOs shows the load-error state on the OS tab", async () => {
  resetDom();
  const panel = new HostKeysPanel({
    porthippo: {
      hostkeys: {
        list: async () => [],
        listOs: async () => {
          throw new Error("nope");
        },
      },
    },
  });
  await panel.load();
  osTab(panel).click();
  await tick();
  assert.ok(panel.element.querySelector(".hostkeys-error"));
  assert.equal(panel.element.querySelector(".hostkeys-empty"), null);
});

test("switching back to the Port Hippo tab reloads its manageable keys", async () => {
  resetDom();
  const { porthippo, calls } = stubBridge({
    pages: [[ENTRY("db.example.com:22", "SHA256:abc")]],
    os: OS_DATA,
  });
  const panel = new HostKeysPanel({ porthippo });
  await panel.load(); // list → 1

  osTab(panel).click();
  await tick();
  porthippoTab(panel).click();
  await tick();

  assert.ok(calls.list >= 2, "the Port Hippo list is re-pulled on return");
  assert.ok(
    panel.element.querySelector(".hostkeys-forget"),
    "the manageable rows (with forget) are back",
  );
});
