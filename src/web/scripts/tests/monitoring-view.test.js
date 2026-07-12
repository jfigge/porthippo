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

import { resetDom } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitoringView } from "../components/monitoring-view.js";

const NOW = 1_000_000_000_000;

function fixtureDefs() {
  return [
    {
      id: "a",
      name: "Alpha",
      localPort: 5432,
      destination: { host: "db", port: 5432 },
    },
    {
      id: "b",
      name: "Beta",
      localPort: 6379,
      destination: { host: "cache", port: 6379 },
    },
  ];
}

function snap(id, state, over = {}) {
  return {
    id,
    state,
    error: null,
    activeConnections: 0,
    bytesUp: 0,
    bytesDown: 0,
    totalBytes: 0,
    rateUp: 0,
    rateDown: 0,
    openedAt: null,
    armedAt: null,
    lastActiveAt: null,
    ...over,
  };
}

/** Push a `porthippo:stats-updated` event carrying a Map id→snapshot. */
function pushStats(snapshots) {
  window.dispatchEvent(
    new CustomEvent("porthippo:stats-updated", {
      detail: { stats: new Map(snapshots.map((s) => [s.id, s])) },
    }),
  );
}

function stubPorthippo(defs, status, calls = {}, filter = "all") {
  return {
    tunnels: {
      list: async () => defs,
      status: async () => status,
      arm: async (id) => ((calls.arm ||= []).push(id), { id }),
      disarm: async (id) => ((calls.disarm ||= []).push(id), { id }),
      pause: async (id) => ((calls.pause ||= []).push(id), { id }),
      resume: async (id) => ((calls.resume ||= []).push(id), { id }),
    },
    settings: {
      get: async () => ({ monitorFilter: filter }),
      set: async (patch) => ((calls.set ||= []).push(patch), patch),
    },
  };
}

async function mount({
  defs = fixtureDefs(),
  status = [],
  calls = {},
  filter = "all",
} = {}) {
  resetDom();
  const view = new MonitoringView({
    porthippo: stubPorthippo(defs, status, calls, filter),
    now: () => NOW,
  });
  document.body.appendChild(view.element);
  await view.load();
  return view;
}

const rows = (view) => view.element.querySelectorAll(".mon-row");
const text = (row, sel) => row.querySelector(sel).textContent;

test("renders one row per definition with the state badge and summary", async () => {
  const view = await mount({ status: [{ id: "a", state: "connected" }] });
  const list = rows(view);
  assert.equal(list.length, 2);
  assert.equal(text(list[0], ".mon-row-name"), "Alpha");
  assert.match(text(list[0], ".mon-row-summary"), /5432.*db.*5432/);
  assert.ok(
    list[0].querySelector(".def-badge--connected"),
    "Alpha badge reflects the seeded connected state",
  );
  assert.ok(list[1].querySelector(".def-badge--disarmed"));
});

test("renders human-formatted stats from the snapshot stream", async () => {
  const view = await mount();
  pushStats([
    snap("a", "connected", {
      rateUp: 12800,
      rateDown: 65536,
      totalBytes: 6 * 1024 * 1024,
      activeConnections: 3,
      openedAt: NOW - 252_000,
      lastActiveAt: NOW - 2_000,
    }),
  ]);
  const row = rows(view)[0];
  assert.equal(text(row, ".mon-rate-up"), "▲ 12.5 KB/s");
  assert.equal(text(row, ".mon-rate-down"), "▼ 64.0 KB/s");
  assert.equal(text(row, ".mon-total"), "total 6.0 MB");
  assert.equal(text(row, ".mon-conns"), "conns 3");
  assert.equal(text(row, ".mon-open"), "up 4m 12s");
  assert.equal(text(row, ".mon-last"), "last 2s ago");
});

test("updates rows in place — same node, changed text", async () => {
  const view = await mount();
  pushStats([snap("a", "connected", { rateUp: 1024 })]);
  const first = rows(view)[0];
  assert.equal(text(first, ".mon-rate-up"), "▲ 1.0 KB/s");

  pushStats([snap("a", "connected", { rateUp: 2048 })]);
  const second = rows(view)[0];
  assert.equal(second, first, "the row DOM node is reused, not rebuilt");
  assert.equal(text(second, ".mon-rate-up"), "▲ 2.0 KB/s");
});

test("the Active filter shows only connected/paused tunnels and persists", async () => {
  const calls = {};
  const view = await mount({
    status: [
      { id: "a", state: "connected" },
      { id: "b", state: "disarmed" },
    ],
    calls,
  });
  assert.equal(rows(view).length, 2, "All shows every definition");

  view.element.querySelector('.mon-filter-btn[data-filter="active"]').click();
  const list = rows(view);
  assert.equal(list.length, 1, "Active hides the disarmed tunnel");
  assert.equal(text(list[0], ".mon-row-name"), "Alpha");
  assert.deepEqual(calls.set, [{ monitorFilter: "active" }]);
});

test("empty states: no definitions vs. no active tunnels", async () => {
  const none = await mount({ defs: [] });
  assert.equal(rows(none).length, 0);
  assert.equal(
    none.element.querySelector(".mon-empty").hidden,
    false,
    "empty state shown when there are no definitions",
  );
  assert.match(
    none.element.querySelector(".mon-empty-text").textContent,
    /No tunnels defined yet/,
  );

  const inactive = await mount({ filter: "active" });
  assert.equal(rows(inactive).length, 0, "no tunnel is connected/paused");
  assert.match(
    inactive.element.querySelector(".mon-empty-text").textContent,
    /No active tunnels/,
  );
});

test("arm/disarm control sends the right intent for the live state", async () => {
  const calls = {};
  const view = await mount({
    status: [
      { id: "a", state: "connected" },
      { id: "b", state: "disarmed" },
    ],
    calls,
  });
  const list = rows(view);
  // Alpha is armed → the button disarms it.
  assert.equal(list[0].querySelector(".mon-arm-btn").textContent, "Disarm");
  list[0].querySelector(".mon-arm-btn").click();
  // Beta is disarmed → the button arms it.
  assert.equal(list[1].querySelector(".mon-arm-btn").textContent, "Arm");
  list[1].querySelector(".mon-arm-btn").click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.disarm, ["a"]);
  assert.deepEqual(calls.arm, ["b"]);
});

test("a refused arm reverts the optimistic badge instead of leaving it wrong", async () => {
  resetDom();
  const view = new MonitoringView({
    porthippo: {
      tunnels: {
        list: async () => [{ id: "a", name: "alpha", routeSummary: "" }],
        status: async () => [{ id: "a", state: "disarmed" }],
        arm: async () => ({ __hippoError: true, message: "engine refused" }),
        disarm: async () => ({ id: "a" }),
        pause: async () => ({}),
        resume: async () => ({}),
      },
      settings: {
        get: async () => ({ monitorFilter: "all" }),
        set: async () => ({}),
      },
    },
    now: () => NOW,
  });
  document.body.appendChild(view.element);
  await view.load();

  const row = () => view.element.querySelector(".mon-row");
  assert.ok(row().querySelector(".def-badge--disarmed"), "starts disarmed");

  // Click Arm; the engine refuses (no correcting state broadcast follows). The
  // badge must revert to disarmed, not stick on the optimistic "listening".
  row().querySelector(".mon-arm-btn").click();
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    row().querySelector(".def-badge--disarmed"),
    "badge reverts after the refused arm",
  );
  assert.ok(!row().querySelector(".def-badge--listening"));
});

test("pause/resume is enabled only when connected/paused", async () => {
  const calls = {};
  const view = await mount({
    status: [
      { id: "a", state: "connected" },
      { id: "b", state: "disarmed" },
    ],
    calls,
  });
  const list = rows(view);
  const pauseA = list[0].querySelector(".mon-pause-btn");
  const pauseB = list[1].querySelector(".mon-pause-btn");
  assert.equal(pauseA.disabled, false);
  assert.equal(pauseA.textContent, "Pause");
  assert.equal(pauseB.disabled, true, "disarmed tunnel can't be paused");
  pauseA.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls.pause, ["a"]);
});

test("Edit dispatches porthippo:edit-tunnel with the tunnel id", async () => {
  const view = await mount();
  let edited = null;
  window.addEventListener("porthippo:edit-tunnel", (e) => {
    edited = e.detail.id;
  });
  rows(view)[1].querySelector(".mon-edit-btn").click();
  assert.equal(edited, "b");
});

test("a tunnel-state broadcast refreshes the badge in place", async () => {
  const view = await mount();
  const row = rows(view)[0];
  assert.ok(row.querySelector(".def-badge--disarmed"));
  window.dispatchEvent(
    new CustomEvent("porthippo:tunnel-state", {
      detail: { id: "a", state: "connecting" },
    }),
  );
  assert.equal(rows(view)[0], row, "same node");
  assert.ok(row.querySelector(".def-badge--connecting"));
});
