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

import { resetDom, change, typeInto } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScheduleEditorField } from "../components/schedule-editor-field.js";

function mount() {
  resetDom();
  const field = new ScheduleEditorField({ porthippo: {} });
  document.body.append(field.element);
  return field;
}

const q = (f, s) => f.element.querySelector(s);
const qa = (f, s) => [...f.element.querySelectorAll(s)];

test("a fresh field with no conditions has no schedule value", () => {
  const f = mount();
  assert.equal(f.value, undefined);
});

test("setValue → value round-trips a time window", () => {
  const f = mount();
  f.setValue({ time: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } });
  assert.deepEqual(f.value, {
    time: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" },
  });
  // The time condition's detail is revealed; the network's stays hidden.
  assert.equal(qa(f, ".schedule-cond-body")[0].hidden, false);
  assert.equal(qa(f, ".schedule-cond-body")[1].hidden, true);
});

test("setValue → value round-trips a network rule (SSIDs + reach)", () => {
  const f = mount();
  f.setValue({
    network: {
      ssids: ["Home", "Office"],
      reach: { host: "10.0.0.1", port: 22 },
    },
  });
  assert.deepEqual(f.value, {
    network: {
      ssids: ["Home", "Office"],
      reach: { host: "10.0.0.1", port: 22 },
    },
  });
});

test("clearing with setValue(null) drops the schedule", () => {
  const f = mount();
  f.setValue({ time: { days: [1], start: "08:00", end: "12:00" } });
  assert.ok(f.value);
  f.setValue(null);
  assert.equal(f.value, undefined);
});

test("enabling the time condition and toggling a day builds a window", () => {
  const f = mount();
  // Turn on "only during certain hours" (the first condition checkbox).
  const timeCheck = qa(f, ".schedule-cond-check")[0];
  change(timeCheck, true);
  // Defaults: Mon–Fri 09:00–17:00 → clicking Sunday (index 0) adds it.
  const days = qa(f, ".schedule-day-btn");
  days[0].click(); // Sunday
  assert.deepEqual(f.value.time.days, [0, 1, 2, 3, 4, 5]);
  // Clicking Monday again removes it.
  days[1].click();
  assert.deepEqual(f.value.time.days, [0, 2, 3, 4, 5]);
});

test("adding and removing an SSID updates the value", () => {
  const f = mount();
  change(qa(f, ".schedule-cond-check")[1], true); // network on
  typeInto(q(f, ".schedule-ssid-input"), "Cafe");
  q(f, ".schedule-ssid-add").click();
  assert.deepEqual(f.value.network.ssids, ["Cafe"]);
  assert.equal(qa(f, ".schedule-ssid-chip").length, 1);

  q(f, ".schedule-ssid-chip-remove").click();
  assert.equal(f.value, undefined); // no conditions left → no schedule
});

test("an incomplete reach (port only) surfaces as an undefined port for the validator", () => {
  const f = mount();
  change(qa(f, ".schedule-cond-check")[1], true);
  typeInto(q(f, ".schedule-reach-host"), "server");
  // Leave the port blank → the value carries host with port undefined so the
  // shared validator can flag schedule.network.reach.port.
  assert.deepEqual(f.value.network.reach, { host: "server", port: undefined });
});
