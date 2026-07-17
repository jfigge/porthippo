# Feature 150 — Scheduling & connectivity-aware auto-arm

## Context

Depends on: **20/30** (engine arm/disarm/pause), **60** (settings, tray, `powerMonitor`
lifecycle), **140** (groups — a rule can target a group). Optional but natural after groups.

Port Hippo arms enabled definitions on launch (`armOnLaunch`) and otherwise leaves arm/disarm
entirely manual. But tunnels have a *context*: a work database tunnel is only wanted during
work hours and only on a trusted network; a home-lab tunnel is pointless away from home. Today
the user micromanages this by hand — arming in the morning, disarming at night, remembering to
pause on public Wi-Fi. This feature lets a tunnel (or a group) **arm and disarm itself** on a
**time schedule** and/or **network condition**, turning Port Hippo from a manual switchboard
into something that follows the user's day.

## Goal

Optional **rules** on a tunnel or group — a **time window** (arm during, disarm outside) and a
**network trigger** (arm only on a named Wi-Fi SSID, or only when a reachability target is up;
disarm on anything else) — evaluated by a main-process scheduler that respects a **manual
override** (a hand toggle wins until the next rule boundary). All detection is **local and
read-only**; no network name or location ever leaves the machine.

## Design decisions (settled — do not relitigate)

- **Rules are declarative data on the definition/group, evaluated centrally.** A `schedule`
  object on a tunnel (and, via Feature 140, on a group whose members inherit it unless they set
  their own). No timers or platform calls scattered through the engine — a single
  `src/app/scheduler.js` owns evaluation and issues plain `engine.arm/disarm` calls. The engine
  stays schedule-unaware.
- **Two independent, ANDable conditions.** `schedule.time` (days-of-week + a start/end local
  time, or "always") and `schedule.network` (an SSID allow-list and/or a reachability probe
  target). A tunnel is *wanted* when **all** enabled conditions are satisfied; the scheduler
  arms wanted tunnels and disarms unwanted ones. Either condition may be absent (then it's not
  a constraint).
- **The scheduler is edge-triggered off real signals, not a busy poll.** It recomputes on:
  a `setTimeout` to the next time-window boundary (recomputed after each firing — no per-second
  tick); Electron `powerMonitor` `resume`/`unlock` (laptop wake); and OS network-change signals
  (`net`/`systemPreferences` where available) plus a slow safety re-check. A reachability probe
  runs only when a rule needs it, on its own modest interval.
- **SSID/reachability detection is best-effort, read-only, and degrades gracefully.** SSID is
  read via the platform's own tool (macOS CoreWLAN/`airport`, Linux `nmcli`, Windows `netsh
  wlan show interfaces`) behind a `network-info.js` seam; where it can't be read, the SSID
  condition is treated as **unknown → does not force-arm** (fail-safe: an ambiguous network
  never *exposes* a tunnel it shouldn't). Reachability is a plain TCP `connect` probe to a
  user-named `host:port`, never a command run anywhere. **No network name, SSID, or probe
  result is logged in the clear or sent off-box** (redacted like any other diagnostic string).
- **Manual override always wins, until the next boundary.** If the user manually arms/disarms a
  tunnel that a rule governs, the scheduler records a transient override and won't fight it; the
  override clears at the next schedule boundary (next window edge / next network change), after
  which rules resume. A per-tunnel "Managed by schedule" indicator shows when a rule (not the
  user) last acted.
- **Disable-by-default and clearly visible.** No tunnel gains a schedule implicitly; a global
  `schedulingEnabled` master switch (default off) plus per-tunnel opt-in. The Monitoring/
  Definition rows badge scheduled tunnels and show the next transition ("arms at 09:00").
- **Time is local wall-clock via the OS.** Windows are evaluated in the machine's local
  timezone using the injected clock seam already used by `stats.js`, so it's testable without
  real time and without a timezone library.

## Data model (next schemaVersion)

```
schedule? {
  time?:    { days: [0..6], start: "HH:MM", end: "HH:MM" },   // omit ⇒ no time constraint
  network?: { ssids?: [string], reach?: { host, port } },     // omit ⇒ no network constraint
}
```
Attachable to a `tunnel` and (Feature 140) a `group`; a member with its own `schedule`
overrides the group's.

## Implementation steps

1. **Model + validate + migration.** Add the optional `schedule` to the tunnel (and group)
   schema and `validate.js` (day list, `HH:MM` range, `end != start`, reachability `host:port`
   sanity); migration is additive (absent = no schedule). Keep validate parity with the
   renderer copy.
2. **`network-info.js`.** A seam returning `{ ssid | null, ... }` via the per-platform tool and
   a `probeReachable(host, port, timeout)` TCP probe; every path is read-only and returns
   `unknown` rather than throwing when the tool is missing. Unit-test the parsers against
   captured CLI fixtures (no real Wi-Fi).
3. **`scheduler.js`.** Pure evaluation `wanted(tunnel, { now, ssid, reachable }) → boolean`
   (fully unit-testable with injected clock/inputs), plus the driver that schedules the next
   boundary timer, subscribes to `powerMonitor` + network-change, runs reachability probes when
   needed, applies the manual-override rule, and calls `engine.arm/disarm`. Built with injected
   Electron/engine (no `require("electron")`), like `tray.js`/`menu.js`.
4. **Wire in `main.js`.** Construct the scheduler after the engine, feed it settings +
   `powerMonitor` events, and tee the manual arm/disarm intents so it can record overrides.
5. **Settings + editor UI.** A global **Scheduling** toggle in Settings; a **Schedule** section
   in the tunnel (and group) editor — a day/time picker and a network condition builder (SSID
   allow-list with a "use current network" helper, and a reachability host:port). Rows badge
   scheduled tunnels with the next transition.
6. **i18n + docs + tests.** Labels into `EN`, regenerate `en.json`. Add a `docs/scheduling.md`
   page (time windows, network rules, the fail-safe/privacy note, manual override) and register
   it in **both** `docs-viewer.js` and `build-docs.mjs` `PAGES`. Tests: `scheduler.test.js`
   (window edges across midnight, days-of-week, AND-ing, override precedence, ambiguous-SSID
   fail-safe — all with injected inputs) and `network-info` parser fixtures. Fold into
   `make test`; header-stamp new files.

## Acceptance criteria

- A tunnel with a time window auto-arms at the window start and auto-disarms at the end, using
  local wall-clock, without a busy poll (verified via the injected clock in tests).
- A tunnel restricted to an SSID (or a reachability target) arms only when that network
  condition holds and disarms when it changes; on a platform/where SSID can't be read, the SSID
  rule fails safe (never force-arms).
- Both conditions AND together; a manual arm/disarm overrides the rule until the next boundary,
  then rules resume.
- Scheduling is off by default and per-tunnel opt-in; scheduled rows show the next transition.
- No SSID, network name, or probe result appears in logs/diagnostics in the clear or leaves the
  machine; `make fmt && make lint && make test` green.

## Constraints

- All detection is **local and read-only** — no command execution on remote hosts, no data
  sent off-box, network identifiers redacted in logs.
- The scheduler lives in main with injected Electron/engine; the engine stays schedule-unaware.
- Edge-triggered, not busy-polled — one timer to the next boundary + OS signals, plus a slow
  safety net; reachability probes only when a rule needs one.
- Ambiguous/unknown network state must fail safe (never expose a tunnel it shouldn't).

## Verify

```
make fmt && make lint && make test
make debug   # give a tunnel a short time window (a couple of minutes out) and watch it
             # auto-arm then auto-disarm at the edges; add an SSID rule for the current
             # network and confirm arm, then a bogus SSID and confirm disarm; manually arm a
             # scheduled-off tunnel and confirm the scheduler doesn't fight it until the next
             # boundary; sleep/wake the laptop and confirm re-evaluation on resume.
```
