# Feature 50 — Monitoring view (UI)

## Context
Feature 30 streams per-tunnel snapshots over `porthippo:stats`, and Feature 40 built the
two-view shell and the Definition pane. This stage builds the **Monitoring view** — the
live operational dashboard that makes Port Hippo feel like a tunnel manager rather than a
config editor. It renders the snapshot stream: a list of tunnels (toggleable between all
and active), each showing current traffic rates, total data transmitted, last-active time,
open time, connection count, and state — with pause/resume and arm/disarm controls. It also
completes the **split view** so definitions and live stats can be seen at once.

## Goal
A Monitoring view listing tunnels with live, throttled stats — up/down rate, total
transmitted, active connections, last-active, open time, and a state badge — with an
all/active filter toggle, per-tunnel pause/resume and arm/disarm controls, and a clean
empty state, all driven purely by the `porthippo:stats` + `porthippo:tunnel-state` streams
and rendered without a framework.

## Design decisions (settled — do not relitigate)
- **Pure subscriber of the snapshot stream.** The view holds no source-of-truth state; it
  renders the latest `porthippo:stats` snapshot (via Feature 30's `stats-store.js`) plus
  definition names from `tunnels.list()`. It never computes stats itself. This keeps main
  authoritative and the UI trivially correct.
- **All vs Active toggle.** A header toggle filters the list: **All** shows every
  definition (including `disarmed`/`listening`); **Active** shows only tunnels currently
  `connected` (or `paused`) — i.e. those actually doing something. Default: All. Persist the
  choice in settings.
- **Rows update in place, not re-created.** On each snapshot, update existing row DOM
  (rate/total/state text + badge) rather than rebuilding the list, so the view is smooth at
  1 Hz and doesn't thrash. Add/remove rows only when the set of tunnels changes.
- **Human-formatted units.** Rates as `KB/s`/`MB/s`, totals as `KB`/`MB`/`GB`, times as
  relative ("3s ago", "up 4m 12s"). Provide a small `format.js` (bytes, rate, duration,
  relative-time) — pure and unit-tested. (When Feature 60's i18n lands, route these through
  `formatNumber`/`formatDate`.)
- **Controls live on the row.** Each row carries: arm/disarm, pause/resume (enabled only
  when `connected`/`paused`), and a jump-to-edit affordance that switches to the Definition
  view for that tunnel (via a `porthippo:edit-tunnel` event). Destructive actions are not
  here (delete stays in Definition).
- **Optional sparkline, not required.** A tiny inline rate sparkline (from Feature 30's
  bounded ring buffer) is a nice-to-have; ship the numeric view first and add the sparkline
  only if cheap. No charting library — a hand-drawn `<canvas>`/SVG path if done at all.
- **Split view is finalized here.** The shell's `split` mode (Feature 40) renders the
  Definition and Monitoring panes side-by-side; this stage ensures the Monitoring pane works
  standalone and within split without duplicate subscriptions.

## Row layout (reference)
`[state badge] name  local→dest   ▲ 12.5 KB/s ▼ 64 KB/s   total 6.0 MB   conns 3   active 4m 12s   last 2s ago   [pause][disarm][edit]`

## Implementation steps
1. **`format.js`** (`src/web/scripts/utils/`): `formatBytes`, `formatRate`,
   `formatDuration`, `formatRelativeTime`, with unit tests (`format.test.js`). Pure
   functions; injectable "now" for the relative-time test.
2. **`monitoring-view.js`** (`src/web/scripts/components/`): subscribes to
   `porthippo:stats-updated` (Feature 30's store) and `porthippo:tunnel-state`; renders one
   row per tunnel; updates rows in place; renders an empty state ("No tunnels defined yet —
   add one in the Definition view") and an active-filter empty state ("No active tunnels").
3. **All/Active toggle** in the view header; filter the rendered set; persist via
   `settings-store`; re-evaluate membership as states change.
4. **Row controls.** Wire arm/disarm → `tunnels.arm/disarm`, pause/resume →
   `tunnels.pause/resume` (disabled unless `connected`/`paused`), edit → dispatch
   `porthippo:edit-tunnel` `{ id }` (the shell switches to Definition and selects it).
5. **State badges + error surfacing.** Shared badge styling for
   disarmed/listening/connecting/connected/paused/error (reuse Feature 40's badge classes);
   on `error`, show the reason on hover and offer a re-arm.
6. **Split view wiring.** Ensure the shell's `split` mode mounts both panes with a single
   `porthippo:stats` subscription shared (or each pane subscribing idempotently); confirm no
   double-render or leak when toggling modes. Responsive CSS grid; collapse to stacked on
   narrow widths.
7. **(Optional) sparkline.** If included, a `rate-sparkline.js` drawing the last N rate
   samples to a small canvas; otherwise explicitly defer and note it.
8. **Tests (jsdom).** `monitoring-view.test.js`: feed synthetic snapshots and assert rows
   render the right formatted values, update in place (same node, changed text), the
   all/active filter includes/excludes correctly, and control clicks call the right
   `window.porthippo.*` methods. Fold into the `test-renderer` target.
9. **License headers**; centralize display strings behind the same `t()`-ready seam as
   Feature 40.

## Acceptance criteria
- The Monitoring view shows a live row per tunnel with up/down rate, total transmitted,
  connection count, last-active, open time, and a state badge, updating smoothly from the
  `porthippo:stats` stream (~1 Hz) with no full-list rebuilds.
- The All/Active toggle correctly filters (Active = connected/paused) and persists.
- Pause/resume and arm/disarm controls work from the row and reflect live state; pausing
  freezes the row's rates while it stays connected; edit jumps to the Definition view for
  that tunnel.
- Values are human-formatted (KB/s, MB, relative times); the empty and active-empty states
  render.
- Split view shows Definition + Monitoring together without duplicate subscriptions or
  leaks.
- `format.test.js` and `monitoring-view.test.js` pass; `make test` green; new files carry
  the license header.

## Constraints
- No framework, no charting library; plain DOM + a hand-drawn sparkline at most. Update
  rows in place. `PopupManager`/design tokens/class-naming per convention.
- The view is a pure subscriber — no stat computation in the renderer; all numbers come
  from `porthippo:stats`.
- Controls act only through `window.porthippo.*`; no direct engine/socket access.
- Keep the single-subscription discipline in split mode (no leaks when toggling views).

## Verify
`make fmt && make lint && make test`, then `make debug`: arm a couple of tunnels, push
traffic, and confirm rows update live with sensible rates/totals/times and that rows update
in place (inspect DOM — nodes persist). Toggle All/Active and confirm filtering +
persistence. Pause a connected tunnel and confirm its rates freeze while state shows
`paused`; resume and confirm flow resumes. Switch to Split view and confirm both panes work
together; click a row's edit and confirm it jumps to that definition.
