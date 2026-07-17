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
import { t, formatDate } from "../i18n.js";
import { scheduleBadgeInfo } from "../components/schedule-badge.js";

const TIME_OPTS = { hour: "numeric", minute: "2-digit" };
const AT = new Date(2026, 0, 5, 9, 0, 0).getTime(); // some concrete instant

test("scheduleBadgeInfo returns null when the tunnel isn't governed", () => {
  resetDom();
  assert.equal(scheduleBadgeInfo(null), null);
});

test("scheduleBadgeInfo describes the next 'arm' transition", () => {
  resetDom();
  const time = formatDate(AT, TIME_OPTS);
  const info = scheduleBadgeInfo({
    id: "t",
    wanted: false,
    overridden: false,
    nextTransitionAt: AT,
    nextTransitionKind: "arm",
  });
  assert.deepEqual(info, {
    overridden: false,
    label: time,
    title: t("schedule.badge.armsAt", { time }),
  });
});

test("scheduleBadgeInfo describes the next 'disarm' transition", () => {
  resetDom();
  const time = formatDate(AT, TIME_OPTS);
  const info = scheduleBadgeInfo({
    id: "t",
    wanted: true,
    overridden: false,
    nextTransitionAt: AT,
    nextTransitionKind: "disarm",
  });
  assert.equal(info.label, time);
  assert.equal(info.title, t("schedule.badge.disarmsAt", { time }));
});

test("scheduleBadgeInfo marks a manual override (no time label)", () => {
  resetDom();
  const info = scheduleBadgeInfo({
    id: "t",
    wanted: true,
    overridden: true,
    nextTransitionAt: AT,
    nextTransitionKind: "disarm",
  });
  assert.equal(info.overridden, true);
  assert.equal(info.label, "");
  assert.equal(
    info.title,
    t("schedule.badge.overriddenUntil", { time: formatDate(AT, TIME_OPTS) }),
  );
});

test("scheduleBadgeInfo falls back to 'managed' for a network-only rule", () => {
  resetDom();
  const info = scheduleBadgeInfo({
    id: "t",
    wanted: true,
    overridden: false,
    nextTransitionAt: null,
    nextTransitionKind: null,
  });
  assert.deepEqual(info, {
    overridden: false,
    label: "",
    title: t("schedule.badge.managed"),
  });
});
