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
 * scheduler.js — connectivity- and time-aware auto-arm (Feature 150).
 *
 * A single main-process driver that evaluates each tunnel's (or its group's)
 * optional `schedule` rule and issues plain `engine.arm/disarm` calls. The engine
 * stays schedule-unaware; all the time/network logic lives here. Built with
 * injected collaborators (engine, powerMonitor, clock, network-info seam) so it
 * never `require("electron")` and is unit-testable headless, like tray.js/menu.js.
 *
 * Evaluation is a pure function — `wanted(schedule, { now, ssid, ssidStatus,
 * reachable })` — that ANDs the two independent conditions:
 *   - `time`: a days-of-week + start/end local-wall-clock window (wrapping past
 *     midnight is fine);
 *   - `network`: an SSID allow-list and/or a reachability `host:port`.
 * A tunnel is *wanted* when every enabled condition holds. An SSID that can't be
 * read is fail-safe (`ssidStatus: "unknown"` ⇒ the SSID condition fails, so an
 * ambiguous network never exposes a tunnel it shouldn't).
 *
 * MANUAL OVERRIDE is realised by EDGE-TRIGGERING: the driver only acts when a
 * tunnel's `wanted` value CHANGES (a window edge / network change), never to
 * correct drift in between. So a hand toggle is never fought until the next
 * boundary, exactly as specified — and it can't fight the user even if a manual
 * path is missed. `noteManual()` additionally records the override so the UI can
 * show "you're in control until HH:MM" (a rule then resumes at the next edge).
 *
 * The driver is edge-triggered off real signals: one `setTimeout` to the next
 * time-window boundary (recomputed after each firing — no per-second tick),
 * `powerMonitor` resume/unlock (laptop wake), and a slow safety re-check that also
 * re-reads the network (SSID/reachability have no reliable OS change event). A
 * reachability probe runs only when a governed rule needs one.
 *
 * PRIVACY: an SSID / probe result only ever flows into the in-memory decision and
 * the (fingerprint-free) `porthippo:schedule` status; it is never logged.
 */
"use strict";

const {
  readSsid: defaultReadSsid,
  probeReachable: defaultProbe,
} = require("./network-info");

const MINUTES_PER_DAY = 1440;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Safety re-check cadence. When a governed rule needs the network (SSID /
// reachability have no reliable OS change event) we re-check briskly; otherwise a
// slow net that just backstops a missed boundary timer / clock drift.
const NETWORK_RECHECK_MS = 60 * 1000;
const SAFETY_RECHECK_MS = 5 * 60 * 1000;

// ── Pure evaluation (fully unit-testable with injected inputs) ─────────────────

/** Parse "HH:MM" (24-hour) to minutes-past-midnight, or null when malformed. */
function toMinutes(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** A day-of-week index (0 = Sunday … 6 = Saturday). */
function isWeekday(v) {
  return Number.isInteger(v) && v >= 0 && v <= 6;
}

/**
 * Localize a ms-epoch to `{ day, minutes }` in the machine's own timezone (via the
 * OS, no timezone library), the shape the pure window check consumes.
 * @param {number} ms
 */
function localNow(ms) {
  const d = new Date(ms);
  return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

/**
 * Is `now` ({ day, minutes }) inside the time window? Absent `time` is not a
 * constraint (true). A same-day window is `[start, end)`; a window whose start is
 * after its end wraps past midnight — its evening portion belongs to the listed
 * day and its morning portion carries over from the previous listed day.
 *
 * @param {{days:number[],start:string,end:string}|undefined} time
 * @param {{day:number,minutes:number}} now
 * @returns {boolean}
 */
function inTimeWindow(time, now) {
  if (!time) return true;
  const start = toMinutes(time.start);
  const end = toMinutes(time.end);
  if (start === null || end === null || start === end) return false;
  const days = (Array.isArray(time.days) ? time.days : []).filter(isWeekday);
  if (!days.length) return false;

  if (start < end) {
    return days.includes(now.day) && now.minutes >= start && now.minutes < end;
  }
  // Wrapping window (e.g. 22:00 → 06:00).
  const prevDay = (now.day + 6) % 7;
  const evening = days.includes(now.day) && now.minutes >= start;
  const morning = days.includes(prevDay) && now.minutes < end;
  return evening || morning;
}

/**
 * Milliseconds from `nowMs` until the time window's membership next flips (an
 * enter or exit edge), or null when there's no usable time rule. Used to arm the
 * single boundary timer.
 *
 * @param {{days:number[],start:string,end:string}|undefined} time
 * @param {number} nowMs
 * @returns {number|null}
 */
function nextTimeBoundaryMs(time, nowMs) {
  if (!time) return null;
  const start = toMinutes(time.start);
  const end = toMinutes(time.end);
  if (start === null || end === null || start === end) return null;
  const days = (Array.isArray(time.days) ? time.days : []).filter(isWeekday);
  if (!days.length) return null;

  const d = new Date(nowMs);
  const curMs =
    ((d.getDay() * MINUTES_PER_DAY + d.getHours() * 60 + d.getMinutes()) * 60 +
      d.getSeconds()) *
      1000 +
    d.getMilliseconds();

  const wrap = start > end;
  const marks = new Set();
  for (const day of days) {
    marks.add(day * MINUTES_PER_DAY + start); // enter
    marks.add(
      wrap
        ? ((day + 1) % 7) * MINUTES_PER_DAY + end // exit next day
        : day * MINUTES_PER_DAY + end, // exit same day
    );
  }

  let best = Infinity;
  for (const mark of marks) {
    let delta = mark * 60000 - curMs;
    delta = ((delta % WEEK_MS) + WEEK_MS) % WEEK_MS;
    if (delta === 0) delta = WEEK_MS; // exactly on an edge → the next cycle
    if (delta < best) best = delta;
  }
  return best === Infinity ? null : best;
}

/**
 * Whether a tunnel with `schedule` is *wanted* right now, given the current
 * inputs. All enabled conditions must hold. An absent condition is not a
 * constraint. An unreadable SSID (`ssidStatus !== "ok"`) fails the SSID condition
 * (fail-safe). A schedule carries at most one reachability target, so `reachable`
 * is a single boolean.
 *
 * @param {object|null} schedule
 * @param {object} inputs
 * @param {{day:number,minutes:number}} inputs.now
 * @param {string|null} [inputs.ssid]
 * @param {"ok"|"unknown"} [inputs.ssidStatus]
 * @param {boolean|null} [inputs.reachable]
 * @returns {boolean}
 */
function wanted(
  schedule,
  { now, ssid = null, ssidStatus = "unknown", reachable = null } = {},
) {
  if (!schedule || typeof schedule !== "object") return true;

  if (!inTimeWindow(schedule.time, now)) return false;

  const network = schedule.network;
  if (network && typeof network === "object") {
    const ssids = Array.isArray(network.ssids) ? network.ssids : [];
    if (ssids.length) {
      const known = ssidStatus === "ok" && typeof ssid === "string";
      if (!known || !ssids.includes(ssid)) return false; // fail-safe on unknown
    }
    if (network.reach && typeof network.reach === "object") {
      if (reachable !== true) return false;
    }
  }
  return true;
}

/** The effective schedule for a tunnel view: its own, else its group's, else null. */
function effectiveSchedule(tunnel) {
  if (tunnel && tunnel.schedule && typeof tunnel.schedule === "object") {
    return tunnel.schedule;
  }
  const groupSchedule = tunnel && tunnel.group && tunnel.group.schedule;
  return groupSchedule && typeof groupSchedule === "object"
    ? groupSchedule
    : null;
}

/** The distinct reachability key for a `{ host, port }` target. */
function reachKey(reach) {
  return `${reach.host}:${reach.port}`;
}

// ── The driver ────────────────────────────────────────────────────────────────

class Scheduler {
  #getStores;
  #engine;
  #powerMonitor;
  #broadcast;
  #now;
  #readSsid;
  #probeReachable;
  #setTimer;
  #clearTimer;
  #setIntervalFn;
  #clearIntervalFn;

  #enabled = false;
  // id → { wanted:boolean, overridden:boolean }. Present only for governed tunnels.
  #state = new Map();
  #boundaryTimer = null;
  #recheckTimer = null;
  #recheckMs = 0;
  #powerHandler = null;
  #reevaluating = false;
  #pending = false;

  /**
   * @param {object} deps
   * @param {() => import('./store/stores').Stores} deps.getStores
   * @param {import('./tunnel/engine').TunnelEngine} deps.engine
   * @param {object} [deps.powerMonitor]  Electron powerMonitor (resume/unlock)
   * @param {(channel:string, payload:object)=>void} [deps.broadcast]
   * @param {() => number} [deps.now]  injected clock (ms epoch)
   * @param {typeof import('./network-info').readSsid} [deps.readSsid]
   * @param {typeof import('./network-info').probeReachable} [deps.probeReachable]
   * @param {typeof setTimeout} [deps.setTimer]
   * @param {typeof clearTimeout} [deps.clearTimer]
   * @param {typeof setInterval} [deps.setIntervalFn]
   * @param {typeof clearInterval} [deps.clearIntervalFn]
   */
  constructor({
    getStores,
    engine,
    powerMonitor,
    broadcast,
    now,
    readSsid,
    probeReachable,
    setTimer,
    clearTimer,
    setIntervalFn,
    clearIntervalFn,
  }) {
    this.#getStores = getStores;
    this.#engine = engine;
    this.#powerMonitor = powerMonitor || null;
    this.#broadcast = broadcast;
    this.#now = now || Date.now;
    this.#readSsid = readSsid || defaultReadSsid;
    this.#probeReachable = probeReachable || defaultProbe;
    this.#setTimer = setTimer || setTimeout;
    this.#clearTimer = clearTimer || clearTimeout;
    this.#setIntervalFn = setIntervalFn || setInterval;
    this.#clearIntervalFn = clearIntervalFn || clearInterval;
  }

  // ── Control surface (main.js) ────────────────────────────────────────────────

  /** Turn scheduling on/off (the global master switch). Idempotent. */
  setEnabled(enabled) {
    const on = Boolean(enabled);
    if (on === this.#enabled) return;
    this.#enabled = on;
    if (on) {
      this.#subscribePower();
      // Kick an evaluation; it schedules the boundary + safety timers itself.
      this.reevaluate();
    } else {
      this.#stopTimers();
      this.#unsubscribePower();
      this.#state.clear();
      this.#broadcast?.("porthippo:schedule", { enabled: false, tunnels: [] });
    }
  }

  /** Re-read definitions after a store write (a schedule added/removed/edited). */
  refresh() {
    if (!this.#enabled) return;
    this.reevaluate();
  }

  /**
   * Record that the user manually armed/disarmed one or more governed tunnels, so
   * the UI can show them as overridden until the next boundary. The edge-triggered
   * driver already won't fight the toggle; this only annotates it.
   * @param {string[]|string} ids
   */
  noteManual(ids) {
    if (!this.#enabled) return;
    const list = Array.isArray(ids) ? ids : [ids];
    let touched = false;
    for (const id of list) {
      const st = this.#state.get(id);
      if (st && !st.overridden) {
        st.overridden = true;
        touched = true;
      }
    }
    if (touched) this.#broadcastStatus();
  }

  /** The ids the scheduler currently governs (so launch-arming can skip them). */
  governedIds() {
    if (!this.#enabled) return new Set();
    return new Set(this.#readGoverned().map((g) => g.id));
  }

  /** Current schedule status for the renderer (pull; also pushed on each change). */
  status() {
    if (!this.#enabled) return { enabled: false, tunnels: [] };
    const nowMs = this.#now();
    return {
      enabled: true,
      tunnels: this.#readGoverned().map((g) =>
        this.#statusEntry(g.id, g.schedule, nowMs),
      ),
    };
  }

  /** Stop all timers + subscriptions (app quit). */
  dispose() {
    this.#stopTimers();
    this.#unsubscribePower();
    this.#state.clear();
  }

  // ── Evaluation ───────────────────────────────────────────────────────────────

  /**
   * Recompute every governed tunnel and act on `wanted` edges. Coalesces
   * overlapping triggers: a signal that arrives mid-run queues exactly one more
   * pass rather than interleaving.
   */
  async reevaluate() {
    if (!this.#enabled) return;
    if (this.#reevaluating) {
      this.#pending = true;
      return;
    }
    this.#reevaluating = true;
    try {
      do {
        this.#pending = false;
        await this.#runOnce();
      } while (this.#pending && this.#enabled);
    } finally {
      this.#reevaluating = false;
    }
  }

  async #runOnce() {
    const governed = this.#readGoverned();
    const governedIds = new Set(governed.map((g) => g.id));

    // Forget any tunnel that stopped being governed (schedule removed / disabled).
    for (const id of [...this.#state.keys()]) {
      if (!governedIds.has(id)) this.#state.delete(id);
    }

    const { ssid, ssidStatus, reachByKey } = await this.#readNetwork(governed);
    // Reading the network can take seconds; if scheduling was turned off in the
    // meantime, abort before acting — `setEnabled(false)` already cleared state +
    // timers, and resuming here would re-arm/disarm the set and restart a timer.
    if (!this.#enabled) return;

    const nowLocal = localNow(this.#now());
    const actions = [];
    for (const g of governed) {
      const reach = g.schedule.network && g.schedule.network.reach;
      const reachable = reach
        ? (reachByKey.get(reachKey(reach)) ?? false)
        : null;
      const want = wanted(g.schedule, {
        now: nowLocal,
        ssid,
        ssidStatus,
        reachable,
      });
      const prev = this.#state.get(g.id);
      if (!prev || want !== prev.wanted) {
        // First assertion or a boundary crossing: act and clear any override.
        this.#state.set(g.id, { wanted: want, overridden: false });
        actions.push({ id: g.id, want });
      }
      // else: no edge → leave the tunnel (and any manual override) untouched.
    }

    for (const a of actions) {
      try {
        if (a.want) await this.#engine.arm(a.id);
        else await this.#engine.disarm(a.id);
      } catch (err) {
        console.error(
          `[scheduler] ${a.want ? "arm" : "disarm"} ${a.id} failed:`,
          err && err.message,
        );
      }
    }

    this.#scheduleBoundary(governed);
    this.#ensureRecheck(governed);
    this.#broadcastStatus();
  }

  /**
   * Read only the network signals the governed set actually needs: the SSID once
   * (if any rule allow-lists SSIDs) and each distinct reachability target (if any
   * rule probes one). Nothing here is logged.
   */
  async #readNetwork(governed) {
    const needsSsid = governed.some(
      (g) =>
        g.schedule.network &&
        Array.isArray(g.schedule.network.ssids) &&
        g.schedule.network.ssids.length,
    );
    const targets = new Map();
    for (const g of governed) {
      const reach = g.schedule.network && g.schedule.network.reach;
      if (reach && reach.host) targets.set(reachKey(reach), reach);
    }

    let ssid = null;
    let ssidStatus = "unknown";
    if (needsSsid) {
      try {
        const res = await this.#readSsid();
        ssid = res.ssid;
        ssidStatus = res.status;
      } catch {
        ssid = null;
        ssidStatus = "unknown";
      }
    }

    const reachByKey = new Map();
    for (const [key, target] of targets) {
      let ok = false;
      try {
        ok = await this.#probeReachable(target.host, target.port);
      } catch {
        ok = false;
      }
      reachByKey.set(key, ok);
    }

    return { ssid, ssidStatus, reachByKey };
  }

  /** The governed tunnels `[{ id, schedule }]`: enabled, with an effective schedule. */
  #readGoverned() {
    let tunnels = [];
    try {
      tunnels = this.#getStores().tunnelStore().list();
    } catch {
      return [];
    }
    const out = [];
    for (const t of tunnels) {
      if (!t || t.enabled === false) continue;
      const schedule = effectiveSchedule(t);
      if (schedule) out.push({ id: t.id, schedule });
    }
    return out;
  }

  // ── Timers + power ───────────────────────────────────────────────────────────

  /** (Re)arm the single boundary timer to the nearest upcoming time-window edge. */
  #scheduleBoundary(governed) {
    if (this.#boundaryTimer) {
      this.#clearTimer(this.#boundaryTimer);
      this.#boundaryTimer = null;
    }
    if (!this.#enabled) return;
    const nowMs = this.#now();
    let soonest = Infinity;
    for (const g of governed) {
      const delta = nextTimeBoundaryMs(g.schedule.time, nowMs);
      if (delta !== null && delta < soonest) soonest = delta;
    }
    if (soonest === Infinity) return;
    // Guard the timer against a zero/negative or absurd delay.
    const delay = Math.min(Math.max(soonest, 1000), WEEK_MS);
    this.#boundaryTimer = this.#setTimer(() => {
      this.#boundaryTimer = null;
      this.reevaluate();
    }, delay);
    this.#boundaryTimer?.unref?.();
  }

  /** Keep the safety re-check interval running at the cadence the rules need. */
  #ensureRecheck(governed) {
    if (!this.#enabled) return; // never (re)start the interval while disabled
    const needsNetwork = governed.some((g) => g.schedule.network);
    const want = needsNetwork ? NETWORK_RECHECK_MS : SAFETY_RECHECK_MS;
    if (this.#recheckTimer && this.#recheckMs === want) return;
    if (this.#recheckTimer) this.#clearIntervalFn(this.#recheckTimer);
    this.#recheckMs = want;
    this.#recheckTimer = this.#setIntervalFn(() => this.reevaluate(), want);
    this.#recheckTimer?.unref?.();
  }

  #stopTimers() {
    if (this.#boundaryTimer) {
      this.#clearTimer(this.#boundaryTimer);
      this.#boundaryTimer = null;
    }
    if (this.#recheckTimer) {
      this.#clearIntervalFn(this.#recheckTimer);
      this.#recheckTimer = null;
      this.#recheckMs = 0;
    }
  }

  #subscribePower() {
    if (!this.#powerMonitor || this.#powerHandler) return;
    this.#powerHandler = () => this.reevaluate();
    try {
      this.#powerMonitor.on("resume", this.#powerHandler);
      this.#powerMonitor.on("unlock-screen", this.#powerHandler);
    } catch {
      /* powerMonitor unavailable — the safety re-check still covers wake drift */
    }
  }

  #unsubscribePower() {
    if (!this.#powerMonitor || !this.#powerHandler) return;
    try {
      this.#powerMonitor.removeListener("resume", this.#powerHandler);
      this.#powerMonitor.removeListener("unlock-screen", this.#powerHandler);
    } catch {
      /* best-effort */
    }
    this.#powerHandler = null;
  }

  // ── Status broadcast ─────────────────────────────────────────────────────────

  #broadcastStatus() {
    if (!this.#broadcast) return;
    this.#broadcast("porthippo:schedule", this.status());
  }

  #statusEntry(id, schedule, nowMs) {
    const st = this.#state.get(id) || { wanted: false, overridden: false };
    const boundary = schedule.time
      ? nextTimeBoundaryMs(schedule.time, nowMs)
      : null;
    // The next TIME edge opens the window (arm) when we're outside it, else closes
    // it (disarm). Network-only rules have no predictable edge.
    const inWindow = inTimeWindow(schedule.time, localNow(nowMs));
    return {
      id,
      wanted: st.wanted,
      overridden: st.overridden,
      nextTransitionAt: boundary === null ? null : nowMs + boundary,
      nextTransitionKind: schedule.time ? (inWindow ? "disarm" : "arm") : null,
    };
  }
}

module.exports = {
  Scheduler,
  // Exported for unit tests + the renderer's parity of intent.
  wanted,
  inTimeWindow,
  nextTimeBoundaryMs,
  localNow,
  effectiveSchedule,
};
