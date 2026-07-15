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

// tunnels-view.test.js — the master-detail container: load renders the list and
// auto-selects, selection drives the detail breadcrumb, live stats/state flow to
// the selected tunnel, arm/delete route through the bridge (delete via the shared
// confirm dialog), and card reordering persists to settings.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { PopupManager } from "../popup-manager.js";
import { TunnelsView } from "../components/tunnels-view.js";

const NOW = 2_000_000;

function stub(
  defs,
  {
    status = [],
    jumps = [],
    settings = {},
    calls = {},
    eventsById = {},
    popupChoose = null,
  } = {},
) {
  return {
    contextMenu: {
      popup: async (request) => {
        (calls.popup ||= []).push(request);
        return typeof popupChoose === "function"
          ? popupChoose(request)
          : popupChoose;
      },
    },
    tunnels: {
      list: async () => defs,
      status: async () => status,
      events: async (id) => (
        (calls.events ||= []).push(id),
        eventsById[id] || []
      ),
      arm: async (id) => (
        (calls.arm ||= []).push(id),
        { id, state: "listening" }
      ),
      disarm: async (id) => (
        (calls.disarm ||= []).push(id),
        { id, state: "disarmed" }
      ),
      pause: async (id) => ((calls.pause ||= []).push(id), { id }),
      resume: async (id) => ((calls.resume ||= []).push(id), { id }),
      create: async (d) => ((calls.create ||= []).push(d), { id: "new", ...d }),
      update: async (id, p) => (
        (calls.update ||= []).push({ id, p }),
        { id, ...p }
      ),
      delete: async (id) => ((calls.delete ||= []).push(id), { id }),
    },
    jumpHosts: { list: async () => jumps },
    credentials: { list: async () => [] },
    settings: {
      get: async () => settings,
      set: async (p) => ((calls.set ||= []).push(p), p),
    },
  };
}

const DEFS = [
  {
    id: "a",
    name: "Alpha",
    bindHost: "127.0.0.1",
    localPort: 18001,
    destination: { host: "127.0.0.1", port: 7000 },
  },
  {
    id: "b",
    name: "Beta",
    bindHost: "127.0.0.1",
    localPort: 18002,
    sshHost: "172.29.0.12",
    sshPort: 22,
    destination: { host: "127.0.0.1", port: 5432 },
  },
];

async function mount(opts = {}) {
  resetDom();
  const calls = opts.calls || {};
  const view = new TunnelsView({
    porthippo: stub(opts.defs || DEFS, { ...opts, calls }),
    now: () => NOW,
  });
  document.body.appendChild(view.element);
  await view.load();
  return { view, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const routeText = (view) =>
  [...view.element.querySelectorAll(".route-seg")].map((s) => s.textContent);

test("load renders the list and auto-selects the first tunnel's detail", async () => {
  const { view } = await mount();
  assert.equal(view.element.querySelectorAll(".tunnel-row").length, 2);
  assert.ok(
    view.element.querySelector(
      ".tunnel-row--selected [class*='tunnel-row-name']",
    )
      ? true
      : view.element.querySelector(".tunnel-row--selected"),
    "a row is selected",
  );
  assert.deepEqual(routeText(view), ["127.0.0.1:18001", "127.0.0.1:7000"]);
});

test("selecting another row updates the detail breadcrumb", async () => {
  const { view } = await mount();
  view.element.querySelectorAll(".tunnel-row")[1].click();
  assert.deepEqual(routeText(view), [
    "127.0.0.1:18002",
    "172.29.0.12:22",
    "127.0.0.1:5432",
  ]);
});

test("a stats snapshot updates the selected tunnel's cards and its dot", async () => {
  const { view } = await mount();
  window.dispatchEvent(
    new CustomEvent("porthippo:stats-updated", {
      detail: {
        stats: new Map([
          [
            "a",
            {
              id: "a",
              state: "connected",
              activeConnections: 4,
              connectionCount: 7,
            },
          ],
        ]),
      },
    }),
  );
  const val = (key) =>
    view.element.querySelector(`.detail-card[data-card="${key}"] .card-value`)
      .textContent;
  assert.equal(val("connections"), "4");
  assert.equal(val("connectionCount"), "7");
  // The list signal for 'a' lit its green lamp (connected).
  const row = view.element.querySelector('.tunnel-row[data-id="a"]');
  assert.ok(row.querySelector(".tunnel-signal--green"));
});

test("the detail arm control routes to tunnels.arm for the selected tunnel", async () => {
  const calls = {};
  const { view } = await mount({ calls });
  view.element.querySelector(".detail-arm-btn").click();
  await tick();
  assert.deepEqual(calls.arm, ["a"]);
});

test("clicking the errored State card opens a dialog with the full error", async () => {
  const { view } = await mount();
  // Tunnel 'a' (auto-selected) reports an error with details.
  window.dispatchEvent(
    new CustomEvent("porthippo:tunnel-state", {
      detail: { id: "a", state: "error", error: "SSH authentication failed" },
    }),
  );
  const stateCard = view.element.querySelector(
    '.detail-card[data-card="state"]',
  );
  assert.ok(stateCard.classList.contains("detail-card--error"));
  stateCard.click();

  const msg = document.querySelector(".popup-notify .popup-message");
  assert.ok(msg, "an error dialog opened");
  assert.match(msg.textContent, /SSH authentication failed/);
  PopupManager.close();
});

test("clicking the Errors card opens the history dialog fetched on demand from main", async () => {
  const { view, calls } = await mount({
    eventsById: {
      a: [
        { at: NOW - 1000, level: "error", message: "bind: address in use" },
        { at: NOW, level: "error", message: "forward failed" },
      ],
    },
  });
  // Tunnel 'a' (auto-selected) reports two errors via a stats snapshot.
  window.dispatchEvent(
    new CustomEvent("porthippo:stats-updated", {
      detail: {
        stats: new Map([["a", { id: "a", state: "error", errorCount: 2 }]]),
      },
    }),
  );
  const errorsCard = view.element.querySelector(
    '.detail-card[data-card="errors"]',
  );
  assert.ok(errorsCard.classList.contains("detail-card--clickable"));
  errorsCard.click();
  await tick();

  assert.deepEqual(calls.events, ["a"], "fetched the history for 'a'");
  const items = document.querySelectorAll(
    ".popup-error-history .error-history-item",
  );
  assert.equal(items.length, 2);
  // Newest first.
  assert.match(
    items[0].querySelector(".error-history-message").textContent,
    /forward failed/,
  );
  PopupManager.close();
});

test("the error dialog surfaces an error reported by status on load", async () => {
  const { view } = await mount({
    status: [{ id: "a", state: "error", error: "port already in use" }],
  });
  view.element.querySelector('.detail-card[data-card="state"]').click();
  const msg = document.querySelector(".popup-notify .popup-message");
  assert.match(msg.textContent, /port already in use/);
  PopupManager.close();
});

test("reordering cards persists the new order to settings", async () => {
  const calls = {};
  const { view } = await mount({ calls });
  const cardEls = [...view.element.querySelectorAll(".detail-card")];
  cardEls[0].dispatchEvent(new Event("dragstart", { bubbles: true }));
  cardEls[2].dispatchEvent(new Event("drop", { bubbles: true }));
  await tick();
  assert.ok(calls.set && calls.set.length >= 1, "settings.set was called");
  assert.ok(
    Array.isArray(calls.set[0].cardOrder),
    "persisted a cardOrder array",
  );
  // Clean up the singleton popup host between tests.
  PopupManager.close();
});

test("a persisted cardOrder is applied to the detail grid", async () => {
  const { view } = await mount({
    settings: { cardOrder: ["errors", "download"] },
  });
  const order = [...view.element.querySelectorAll(".detail-card")].map(
    (c) => c.dataset.card,
  );
  assert.equal(order[0], "errors", "saved order leads");
  assert.equal(order[1], "download");
});

// ── View mode (cards ↔ list) ─────────────────────────────────────────────────

test("a set-detail-mode intent (from the header) toggles the split/table and persists it", async () => {
  const calls = {};
  const { view } = await mount({ calls });
  assert.equal(view.element.querySelector(".tunnels-split").hidden, false);
  assert.equal(view.element.querySelector(".tunnel-table-view").hidden, true);

  window.dispatchEvent(
    new CustomEvent("porthippo:set-detail-mode", { detail: { mode: "list" } }),
  );
  assert.equal(view.element.querySelector(".tunnels-split").hidden, true);
  assert.equal(view.element.querySelector(".tunnel-table-view").hidden, false);
  assert.ok(
    (calls.set || []).some((p) => p.detailMode === "list"),
    "detailMode persisted",
  );
});

test("in list mode, the table toolbar arm control routes to tunnels.arm", async () => {
  const calls = {};
  const { view } = await mount({ calls, settings: { detailMode: "list" } });
  // 'a' is auto-selected; the table toolbar's arm button acts on it.
  view.element.querySelector(".tunnel-table-view .detail-arm-btn").click();
  await tick();
  assert.deepEqual(calls.arm, ["a"]);
});

test("the view echoes detail-mode-changed so the header selector can sync", async () => {
  const { view } = await mount();
  const seen = [];
  window.addEventListener("porthippo:detail-mode-changed", (e) =>
    seen.push(e.detail && e.detail.mode),
  );
  window.dispatchEvent(
    new CustomEvent("porthippo:set-detail-mode", { detail: { mode: "list" } }),
  );
  assert.equal(seen.at(-1), "list");
  assert.equal(view.element.querySelector(".tunnel-table-view").hidden, false);
});

test("a persisted detailMode of list starts in the list view", async () => {
  const { view } = await mount({ settings: { detailMode: "list" } });
  assert.equal(view.element.querySelector(".tunnels-split").hidden, true);
  assert.equal(view.element.querySelector(".tunnel-table-view").hidden, false);
  assert.equal(view.element.querySelectorAll(".tt-row").length, 2);
});

test("the list view shares the persisted card order as its columns", async () => {
  const { view } = await mount({
    settings: { detailMode: "list", cardOrder: ["connections", "download"] },
  });
  const cols = [...view.element.querySelectorAll(".tt-th")].map(
    (t) => t.dataset.col,
  );
  assert.deepEqual(cols, ["__tunnel", "connections", "download"]);
});

// ── Row context menu (native OS menu on secondary-click) ─────────────────────

const rightClick = (view, id) =>
  view.element
    .querySelector(`.tunnel-row[data-id="${id}"]`)
    .dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );
// Drain the popup promise → switch → follow-on action (openClone awaits a few).
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const itemById = (items, id) => items.find((i) => i.id === id);

test("right-clicking a row pops a native menu whose items match the spec + state", async () => {
  const calls = {};
  const { view } = await mount({ calls });
  rightClick(view, "a"); // 'a' is disarmed on load
  await settle();

  assert.equal(calls.popup.length, 1, "one popup requested");
  const items = calls.popup[0].items;
  // Edit · — · Pause/Play · Arm/Disarm · — · Clone · — · Delete.
  assert.deepEqual(
    items.map((i) => (i.type === "separator" ? "—" : i.id)),
    ["edit", "—", "pause", "arm", "—", "clone", "—", "delete"],
  );
  assert.equal(itemById(items, "edit").label, "Edit");
  assert.equal(itemById(items, "clone").label, "Clone");
  assert.equal(itemById(items, "delete").label, "Delete");
  // Disarmed → "Arm", and Pause is offered but disabled (nothing to pause).
  assert.equal(itemById(items, "arm").label, "Arm");
  assert.equal(itemById(items, "pause").label, "Pause");
  assert.equal(itemById(items, "pause").enabled, false);
});

test("the menu's Pause/Play + Arm/Disarm labels track the live state", async () => {
  const calls = {};
  const { view } = await mount({ calls });
  const emit = (state) =>
    window.dispatchEvent(
      new CustomEvent("porthippo:tunnel-state", { detail: { id: "a", state } }),
    );

  emit("connected");
  rightClick(view, "a");
  await settle();
  let items = calls.popup.at(-1).items;
  assert.equal(itemById(items, "arm").label, "Disarm");
  assert.equal(itemById(items, "pause").label, "Pause");
  assert.equal(itemById(items, "pause").enabled, true);

  emit("paused");
  rightClick(view, "a");
  await settle();
  items = calls.popup.at(-1).items;
  assert.equal(itemById(items, "pause").label, "Play");
  assert.equal(itemById(items, "pause").enabled, true);
});

test("choosing Delete from the row menu confirms then deletes", async () => {
  const calls = {};
  const { view } = await mount({ calls, popupChoose: "delete" });
  rightClick(view, "b");
  await settle();
  const danger = document.querySelector(".popup-confirm .btn--danger");
  assert.ok(danger, "the shared delete confirm opened");
  danger.click();
  await tick();
  assert.deepEqual(calls.delete, ["b"]);
});

test("choosing Arm from the row menu routes to tunnels.arm", async () => {
  const calls = {};
  const { view } = await mount({ calls, popupChoose: "arm" });
  rightClick(view, "a");
  await settle();
  assert.deepEqual(calls.arm, ["a"]);
});

test("choosing Clone opens a create editor prefilled from the row, name blanked", async () => {
  const { view } = await mount({ popupChoose: "clone" });
  rightClick(view, "b"); // Beta → 172.29.0.12:22, port 5432
  await settle();
  const dlg = document.querySelector(".tunnel-dialog");
  assert.ok(dlg && dlg.open, "the tunnel editor opened");
  assert.equal(
    dlg.querySelector(".editor-input-name").value,
    "",
    "the copied name is blanked",
  );
  assert.equal(
    dlg.querySelector(".editor-input-targetServer").value,
    "172.29.0.12",
    "the target server carried over",
  );
});

test("in list mode a right-click on a table row also pops the native menu", async () => {
  const calls = {};
  const { view } = await mount({
    calls,
    settings: { detailMode: "list" },
    popupChoose: "arm",
  });
  view.element
    .querySelector('.tt-row[data-id="b"]')
    .dispatchEvent(
      new Event("contextmenu", { bubbles: true, cancelable: true }),
    );
  await settle();
  assert.ok((calls.popup || []).length >= 1, "a popup was requested");
  assert.deepEqual(calls.arm, ["b"]);
});
