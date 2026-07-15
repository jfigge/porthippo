# Feature 130 — Failure notifications & connection health

## Context

Depends on: **20/30** (engine + stats), **60** (tray, native `Notification`, settings,
logging), **50** (Monitoring view). No data-shape change to the tunnel record beyond an
optional retry override.

The engine already reconnects on an unexpected SSH drop — `tunnel.js` runs a
**bounded exponential backoff** (`#reconnectTimer` / `#reconnectAttempts`, base/max backoff
deps, `keepAlive` retries forever, `autoReconnect` retries then stops on next-access) and
only lands in `error` on exhaustion. What's missing is everything the **user** needs around
that: they are never *told* a tunnel dropped, the reconnect is invisible (no attempt count,
no countdown), a half-dead peer isn't detected until TCP eventually times out, and the retry
policy is hard-coded with no way to tune it. For a background utility whose whole job is
"keep my tunnel up," silent failure is the worst outcome.

Port Hippo already uses `new Notification(...)` in `main.js` (the one-off "running in the
tray" hint), so the OS notification surface is proven — this feature puts it to work.

## Goal

Make connection health **visible and tunable** without changing the reconnect algorithm's
core: desktop notifications on drop / recovery / give-up (coalesced, user-toggleable, DND-
respecting), **active keepalive probing** so a dead peer is detected in seconds, a
**reconnect countdown + attempt count** surfaced in Monitoring, a **tray health rollup**
(all-healthy / reconnecting / error), and a **retry policy** (base/max backoff, max attempts)
configurable globally with an optional per-tunnel override.

## Design decisions (settled — do not relitigate)

- **The engine emits richer lifecycle events; it does not change the algorithm.** Add typed
  transitions to the existing broadcast — `dropped`, `reconnecting` (with `attempt`,
  `nextRetryAt`), `recovered`, `gave-up` — carried on the existing `porthippo:tunnel-state`
  broadcast payload (never a new secret-bearing channel). The backoff math in `tunnel.js`
  stays; we only surface its state.
- **Active keepalive uses ssh2's built-in probing.** Pass `keepaliveInterval` /
  `keepaliveCountMax` to each `ssh2.Client` in `ssh-chain.js` so a black-holed connection is
  detected in ~tens of seconds instead of hanging on the OS TCP timeout. Interval is a
  setting (0 = off). This is the SSH-layer heartbeat; it is distinct from the existing app
  `keepAlive` *definition* flag (hold-open-while-armed) — name them carefully in UI/docs to
  avoid confusion (`sshKeepaliveSeconds` setting vs. the tunnel's `keepAlive`).
- **Notifications are coalesced, opt-outable, and never leak secrets.** A new
  `src/app/notifications.js` (pure builder + injected `Notification`, like `tray.js` takes
  injected Electron) turns lifecycle events into notification payloads using main-side i18n
  (`i18n.js` `label`). Rules: **debounce** a flapping tunnel (no more than one drop notice per
  tunnel per cooldown), notify on *recovered* only if a *dropped* was shown, always notify on
  *gave-up* and on `porthippo:hostkey-changed`. Payloads carry the tunnel **name** only —
  never a host, user, or secret. A Settings toggle (master on/off) plus per-event granularity;
  respect OS Do-Not-Disturb (rely on `Notification.isSupported()` + the OS honouring DND).
- **The retry policy becomes data.** Promote the current hard-coded backoff deps to settings
  — `reconnectBaseMs`, `reconnectMaxMs`, `reconnectMaxAttempts` — seeded from today's values,
  with an optional per-tunnel `retry?: { baseMs?, maxMs?, maxAttempts? }` override read live
  by `tunnel.js` (like `lingerMs`/`autoReconnect` are). Tests keep injecting shrunk values.
- **Health is a derived rollup, computed once in main.** The tray and menu show a single
  health state (`healthy` if all armed tunnels are connected/listening; `reconnecting` if any
  is retrying; `error` if any gave up), teed from the same `tunnel-state` broadcast that
  already feeds `tray.update()`. No new polling.
- **The renderer only displays.** Monitoring shows the attempt count and a live countdown to
  `nextRetryAt`; the Settings dialog edits the policy + notification prefs; nothing about
  health logic moves to the renderer.

## Settings added (DEFAULTS)

```
notifyOnDrop: true, notifyOnRecover: true, notifyOnGiveUp: true,   // per-event
notifyCooldownMs: 60000,                                           // flap debounce
sshKeepaliveSeconds: 15,                                           // 0 = off
reconnectBaseMs: <existing base>, reconnectMaxMs: <existing max>,
reconnectMaxAttempts: <existing>,                                  // per-tunnel override on the record
```

## Implementation steps

1. **Lifecycle events.** In `tunnel.js`/`engine.js`, extend the state broadcast with the
   typed transitions + `attempt` / `nextRetryAt`, emitted at the existing backoff decision
   points (schedule reconnect, attempt fail, success, exhaustion). No algorithm change.
2. **ssh2 keepalive.** Thread `sshKeepaliveSeconds` into the client options in `ssh-chain.js`
   (every hop). Confirm a probe-driven drop flows through the same reconnect path as a socket
   error.
3. **Retry policy as data.** Read base/max/attempts from settings with a per-tunnel `retry`
   override in `tunnel.js`; keep the test hooks. Add `validate.js` bounds for the override.
4. **`notifications.js`.** Pure payload builder + injected `Notification`; debounce/coalesce
   state; i18n labels via main `i18n.js`. Wire it in `main.js` off the same broadcast tee that
   updates the tray. Clicking a notification focuses the window (reuse the single-instance
   focus path).
5. **Tray/menu health rollup.** Compute the rollup in `main.js` from the broadcast and pass it
   to `tray.update()` (glyph/badge state in `tray-icon.js`) and the native menu summary line.
6. **Monitoring UI.** In `tunnel-table.js`/`tunnel-detail.js` show a `reconnecting` badge with
   the live attempt/countdown (a small ticking label off `nextRetryAt`); a `gave-up` row gets
   a **Retry now** action (calls `tunnels:apply`/re-arm).
7. **Settings UI.** A **Notifications & reliability** group in the Settings dialog: master +
   per-event notification toggles, cooldown, SSH keepalive interval, and the reconnect policy
   fields; the per-tunnel override lives in the tunnel editor's advanced section.
8. **i18n + docs + tests.** Add labels to `EN`, regenerate `en.json`. Update
   `docs/troubleshooting.md` (what each notification means; keepalive vs. keep-alive; tuning
   retries). Tests: `notifications.test.js` (debounce/coalesce, secret-free payloads, event
   gating), engine tests asserting the new transitions + per-tunnel override, a
   `diagnostics`/`redact` check that notification text carries no secret. Fold into
   `make test`; header-stamp new files.

## Acceptance criteria

- When an armed tunnel's SSH connection drops, the user gets a single OS notification (subject
  to the toggle + cooldown), Monitoring shows a `reconnecting` badge with a live attempt count
  and countdown, and a successful reconnect shows a *recovered* notice (only if a drop was
  shown).
- A black-holed peer is detected within the configured keepalive window rather than hanging
  until the OS TCP timeout.
- The reconnect base/max/attempts are editable in Settings and overridable per tunnel; a
  `gave-up` tunnel shows **Retry now**.
- The tray reflects an aggregate health state (healthy / reconnecting / error).
- No notification, log, or diagnostic contains a host, username, or secret — only tunnel
  names; `make fmt && make lint && make test` green.

## Constraints

- Do **not** rewrite the reconnect algorithm — surface and parameterise the existing one.
- Notification building and health rollup live in main; the renderer displays and edits prefs.
- Coalesce aggressively — a flapping tunnel must not spam the user.
- Secrets/hosts never appear in notification text (tunnel name only), per the app's redaction
  posture.

## Verify

```
make fmt && make lint && make test
make debug   # arm a keepAlive tunnel; kill the SSH server (or drop the network) and confirm:
             # one drop notification, a reconnecting badge with a ticking countdown, a
             # recovered notification when it returns, and the tray health state tracking it.
             # Set reconnectMaxAttempts low + kill the far end permanently → a give-up
             # notification + a Retry-now action. Toggle notifications off and confirm silence.
```
