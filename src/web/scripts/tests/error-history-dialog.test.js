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

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { buildErrorHistory } from "../components/error-history-dialog.js";

const NOW = 5_000_000;

test("an empty history shows the empty message, no list", () => {
  resetDom();
  const el = buildErrorHistory({ events: [], title: "Error history — Alpha" });
  assert.ok(el.classList.contains("popup"));
  assert.equal(
    el.querySelector(".popup-title").textContent,
    "Error history — Alpha",
  );
  assert.ok(el.querySelector(".popup-message"), "empty message shown");
  assert.equal(el.querySelector(".error-history-list"), null);
});

test("events render newest-first with level, time and message", () => {
  resetDom();
  const el = buildErrorHistory({
    title: "Error history — Alpha",
    now: () => NOW,
    events: [
      { at: NOW - 60000, level: "error", message: "bind: address in use" },
      { at: NOW - 1000, level: "error", message: "forward failed" },
    ],
  });
  const items = [...el.querySelectorAll(".error-history-item")];
  assert.equal(items.length, 2);
  // Newest first: the "forward failed" (most recent) leads.
  assert.match(
    items[0].querySelector(".error-history-message").textContent,
    /forward failed/,
  );
  assert.match(
    items[1].querySelector(".error-history-message").textContent,
    /address in use/,
  );
  assert.equal(
    items[0].querySelector(".error-history-level").textContent,
    "Error",
  );
  assert.ok(
    items[0].querySelector(".error-history-time").textContent.length > 0,
  );
});

test("a warning-level event is styled and labelled as a warning", () => {
  resetDom();
  const el = buildErrorHistory({
    title: "History",
    now: () => NOW,
    events: [{ at: NOW, level: "warning", message: "slow response" }],
  });
  const item = el.querySelector(".error-history-item");
  assert.ok(item.classList.contains("error-history-item--warning"));
  assert.equal(
    item.querySelector(".error-history-level").textContent,
    "Warning",
  );
});

test("the Close button fires onClose", () => {
  resetDom();
  let closed = 0;
  const el = buildErrorHistory({
    title: "History",
    events: [],
    onClose: () => closed++,
  });
  el.querySelector(".popup-footer .btn").click();
  assert.equal(closed, 1);
});
