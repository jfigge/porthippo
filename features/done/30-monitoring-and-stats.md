# Feature 30 — Monitoring, stats & pause/resume

## Context
Feature 20 gives us a working engine that relays bytes and owns the data path. Because we
own that path, we can measure it. This stage turns the engine's raw activity into the
**metrics the Monitoring view (Feature 50) will render** — traffic rates, totals,
last-active time, open time, connection counts, state — and adds **pause/resume**, the
product requirement to suspend a tunnel's traffic without destroying it. This is a
main-process stage: it produces the data and the control surface; the visual UI is
Feature 50.

The relay (`relay.js`) already increments byte counters (Feature 20, step 4). Here we
aggregate them per tunnel, derive rates over a rolling window, and stream throttled
snapshots to the renderer, following Rest Hippo's pattern of a main-owned source of truth
broadcast to the renderer over a `porthippo:*` event.

## Goal
Per-tunnel live statistics — up/down byte totals, current up/down rates, total data
transmitted, active connection count, last-active timestamp, and open time — collected in
main and streamed to the renderer as throttled snapshots, plus a **pause/resume** control
that halts data flow (and stops accepting new local connections) while keeping the SSH
connection and the definition intact.

## Design decisions (settled — do not relitigate)
- **Metrics live in the engine, in main.** Each `Tunnel` owns a `Stats` object updated by
  its relays. There is no per-connection IPC chatter — the engine emits **one throttled
  snapshot of all tunnels** (default ~1 Hz) over `porthippo:stats`. The renderer is a pure
  view of that snapshot.
- **Rates are a rolling measurement, not instantaneous.** Compute up/down bytes-per-second
  from a short sliding window (e.g. 1s buckets over a few seconds, or an EWMA) so the
  displayed rate is stable, not spiky. Totals are monotonic counters.
- **"Open time" = time since the SSH connection was established** (the current
  `connected` session), and resets when the connection is torn down at idle. **"Listener
  uptime" = time since armed** is tracked separately (both are useful; the UI in Feature 50
  decides which to headline). **"Last active" = timestamp of the last byte in either
  direction.**
- **Pause semantics (settled):** pausing an active tunnel (a) stops the local listener from
  accepting **new** connections and (b) pauses byte flow on existing relays
  (`socket.pause()` / stop reading both directions), while **keeping the SSH connection and
  all sockets alive**. State becomes `paused`; rates read zero; totals freeze. Resume
  re-accepts and un-pauses. Pause never tears down SSH and never touches the stored
  definition — it is a runtime toggle. A paused tunnel can still be disarmed (which fully
  cleans up).
- **Snapshots are cheap and stateless.** A snapshot is a plain serializable array the
  renderer can diff/render directly; no live object references cross IPC.
- **History depth is bounded.** Keep only what the UI needs live (current rates, a small
  ring buffer for an optional sparkline). No on-disk metrics persistence in this stage
  (could be a later feature); stats reset on app restart.

## Snapshot shape (reference)
```jsonc
{
  "id": "uuid",
  "state": "connected",          // disarmed|listening|connecting|connected|paused|error
  "activeConnections": 3,
  "bytesUp": 1048576,            // session or cumulative-since-arm (document which)
  "bytesDown": 5242880,
  "totalBytes": 6291456,
  "rateUp": 12800,              // bytes/sec, rolling
  "rateDown": 65536,
  "openedAt": 1720300000000,    // ms epoch of current SSH connect, null if not connected
  "armedAt": 1720299000000,
  "lastActiveAt": 1720300123000,
  "error": null
}
```

## Implementation steps
1. **`src/app/tunnel/stats.js`.** A per-tunnel `Stats` class: `addUp(n)`, `addDown(n)`,
   `connOpened()`, `connClosed()`, `onConnected()`, `onDisconnected()`, `snapshot()`.
   Maintains monotonic totals, a rolling-window rate estimator, `activeConnections`,
   `lastActiveAt`, `openedAt`, `armedAt`. Pure and unit-testable with an injected clock.
2. **Wire counters.** Have `relay.js` call `stats.addUp/addDown` from its byte counters and
   `connOpened/connClosed` on relay open/close; have `tunnel.js` call
   `onConnected/onDisconnected` on SSH connect/teardown and set `armedAt` on arm.
3. **Snapshot broadcaster.** In `engine.js`, a single throttled timer (start when ≥1 tunnel
   is armed, stop when none are) collects `snapshot()` from every tunnel and emits
   `porthippo:stats` to all renderer windows. Also emit an immediate snapshot on any state
   change (so the UI doesn't wait up to a second to reflect connect/disconnect/pause).
4. **Pause/resume in the engine.** Add `pause(id)` / `resume(id)` to `Tunnel` + `Engine`:
   pause stops the listener accepting, pauses every live relay's streams, sets state
   `paused`, freezes rates; resume reverses it. Ensure disarm-while-paused and
   SSH-drop-while-paused are handled cleanly.
5. **IPC + preload.** `tunnels:pause`, `tunnels:resume` handlers; expose
   `window.porthippo.tunnels.pause/resume`. The renderer subscribes to `porthippo:stats`
   via an existing `onEvent`-style bridge (or `ipcRenderer.on` surfaced through preload as
   `window.porthippo.onStats(cb)`). Keep main/preload in lockstep.
6. **Renderer stats store (thin).** A small `src/web/scripts/stats-store.js` that holds the
   latest snapshot map and re-emits a `porthippo:stats-updated` DOM event, so Feature 50's
   view is a pure subscriber. No rendering here — just the data seam.
7. **Tests.** `stats.test.js` (rate math with a fake clock: burst then idle → rate decays
   to zero; totals monotonic; connection counting) and an engine-level
   `pause-resume.test.js` extending Feature 20's in-process harness (bytes flow →
   pause → no bytes, SSH still up, state `paused` → resume → bytes flow again). Fold into
   `make test`.
8. **License headers** on new files.

## Acceptance criteria
- With traffic flowing through a tunnel, `porthippo:stats` snapshots show non-zero up/down
  **rates** that decay to zero shortly after traffic stops, and monotonically increasing
  **totals**.
- `activeConnections`, `lastActiveAt`, `openedAt` (SSH session), and `armedAt` are accurate
  across connect/idle-teardown/reconnect cycles.
- Pausing an active tunnel freezes its rates and stops new + in-flight traffic **without**
  dropping the SSH connection or altering the stored definition; resuming restores flow.
- Snapshots are emitted on a throttle **and** immediately on state changes; no per-byte or
  per-connection IPC.
- `stats.test.js` and `pause-resume.test.js` pass; `make test` green; new files carry the
  license header.

## Constraints
- Metrics and pause/resume live entirely in **main**; the renderer only receives snapshots
  and sends pause/resume/disarm intents.
- No metrics library — the rolling-rate math is a few lines against an injected clock (so
  it's testable without real time).
- Bounded memory: no unbounded history buffers; no on-disk metrics in this stage.
- Snapshots must be plain serializable data (no live handles over IPC).

## Verify
`make fmt && make lint && make test`. Then `make debug`: arm a tunnel, push traffic
through the local port, and watch `porthippo:stats` in DevTools — confirm rates rise under
load and decay to zero when idle, totals only grow, and `activeConnections` tracks live
connections. Call `window.porthippo.tunnels.pause(id)` mid-transfer and confirm traffic
halts while state is `paused` and the SSH connection stays up; `resume(id)` and confirm
flow returns.
