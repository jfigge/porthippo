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
import { DefinitionView } from "../components/definition-view.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function fixtureDefs() {
  return [
    {
      id: "a",
      name: "Alpha",
      localPort: 5432,
      destination: { host: "db", port: 5432 },
      credentialId: "c1",
      jumpHostIds: [],
      routeSummary: ":5432 → db:5432",
    },
    {
      id: "b",
      name: "Beta",
      localPort: 6379,
      destination: { host: "cache", port: 6379 },
      credentialId: "c1",
      jumpHostIds: [],
      routeSummary: ":6379 → cache:6379",
    },
  ];
}

function stubPorthippo(defs, calls = {}) {
  return {
    tunnels: {
      list: async () => defs,
      status: async () => [],
      arm: async (id) => (
        (calls.arm ||= []).push(id),
        { id, state: "listening" }
      ),
      disarm: async (id) => (
        (calls.disarm ||= []).push(id),
        { id, state: "disarmed" }
      ),
      create: async (def) => (
        (calls.create ||= []).push(def),
        { id: "new", ...def }
      ),
      update: async (id, patch) => (
        (calls.update ||= []).push({ id, patch }),
        { id, ...patch }
      ),
      delete: async (id) => ((calls.delete ||= []).push(id), { id }),
    },
    credentials: {
      list: async () => [{ id: "c1", label: "Prod", authType: "agent" }],
    },
    jumpHosts: { list: async () => [] },
  };
}

async function mount(defs = fixtureDefs(), calls = {}) {
  resetDom();
  const view = new DefinitionView({ porthippo: stubPorthippo(defs, calls) });
  document.body.appendChild(view.element);
  await view.load();
  return view;
}

test("lists a row per definition with its route summary", async () => {
  const view = await mount();
  const rows = view.element.querySelectorAll(".def-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".def-row-name").textContent, "Alpha");
  assert.equal(
    rows[0].querySelector(".def-row-summary").textContent,
    ":5432 → db:5432",
  );
});

test("Edit opens the modal prefilled from the definition", async () => {
  const view = await mount();
  const dialog = view.element.querySelector(".tunnel-dialog");
  assert.ok(!dialog.open, "modal closed until Edit");

  view.element.querySelector(".def-edit-btn").click();
  await flush();

  assert.ok(dialog.open, "modal opened");
  assert.equal(dialog.querySelector(".editor-input-name").value, "Alpha");
  assert.equal(dialog.querySelector(".editor-input-destHost").value, "db");
});

test("New tunnel opens a blank modal", async () => {
  const view = await mount();
  view.element.querySelector(".def-add-btn").click();
  await flush();
  const dialog = view.element.querySelector(".tunnel-dialog");
  assert.ok(dialog.open);
  assert.equal(dialog.querySelector(".editor-input-name").value, "");
});

test("the arm toggle sends an arm intent for a disarmed tunnel", async () => {
  const calls = {};
  const view = await mount(fixtureDefs(), calls);
  view.element.querySelector(".def-arm-btn").click();
  await flush();
  assert.deepEqual(calls.arm, ["a"]);
});

test("a tunnel-state broadcast updates the badge", async () => {
  const view = await mount();
  window.dispatchEvent(
    new CustomEvent("porthippo:tunnel-state", {
      detail: { id: "b", state: "connected" },
    }),
  );
  const betaRow = view.element.querySelectorAll(".def-row")[1];
  assert.ok(betaRow.querySelector(".def-badge--connected"));
});

test("a tunnel-state broadcast preserves keyboard focus on the arm button", async () => {
  const view = await mount();
  const row = view.element.querySelectorAll(".def-row")[0];
  const armBtn = row.querySelector(".def-arm-btn");
  armBtn.focus();
  assert.equal(
    document.activeElement,
    armBtn,
    "focus starts on the arm button",
  );

  window.dispatchEvent(
    new CustomEvent("porthippo:tunnel-state", {
      detail: { id: "a", state: "connected" },
    }),
  );

  // The row updated in place, so the SAME button is still there and focused — a
  // full re-render would have destroyed it and dropped focus to <body>.
  const armBtnAfter = view.element
    .querySelectorAll(".def-row")[0]
    .querySelector(".def-arm-btn");
  assert.equal(armBtnAfter, armBtn, "the arm button was not recreated");
  assert.equal(document.activeElement, armBtn, "focus is preserved");
  assert.ok(row.querySelector(".def-badge--connected"), "badge still updated");
});

test("deleting confirms then calls delete", async () => {
  const calls = {};
  const view = await mount(fixtureDefs(), calls);
  view.element.querySelector(".def-delete-btn").click();
  document.querySelector(".popup-confirm .btn--danger").click();
  await flush();
  assert.deepEqual(calls.delete, ["a"]);
});

test("duplicate creates a copy with a suffixed name and same references", async () => {
  const calls = {};
  const view = await mount(fixtureDefs(), calls);
  view.element.querySelector(".def-duplicate-btn").click();
  await flush();
  assert.equal(calls.create.length, 1);
  const copy = calls.create[0];
  assert.equal(copy.name, "Alpha (copy)");
  assert.equal(copy.credentialId, "c1");
  assert.equal(copy.id, undefined, "the copy is a fresh record");
  assert.equal(copy.routeSummary, undefined, "derived fields are stripped");
});
