# Feature 110 — Reverse & dynamic port forwarding (tunnel types: local / remote / SOCKS)

## Context

Depends on: **20** (SSH tunnel engine), **30** (stats/pause), **45** (definition model +
resolver), **50** (Monitoring view). Builds directly on the existing engine.

Today every Port Hippo tunnel is a **local forward** (`ssh -L`): a local listener binds a
port, and on first access the engine opens a `direct-tcpip` channel (`forwardOut`) through
the SSH chain to the destination and relays bytes (`src/app/tunnel/{listener,relay,ssh-chain}.js`).
That is one of the three forwarding modes real SSH offers. The two missing modes are the
biggest genuine capability gap versus every other SSH tunnel manager:

- **Remote forward (`ssh -R`)** — bind a port **on the far end** and forward connections
  *back* to a local (or local-network) service. Needed to expose something running on this
  machine to the remote side (webhooks to a dev box, a database behind the user's laptop).
- **Dynamic forward / SOCKS (`ssh -D`)** — bind a **local SOCKS5 proxy** whose every CONNECT
  is forwarded through the SSH chain, so a browser/app can reach *any* host reachable from
  the far end without a per-host tunnel. The single most-requested "power" tunnel.

`ssh2` gives us the primitives for both: `client.forwardIn()` + the `"tcp connection"` event
for remote forwards, and `client.forwardOut()` (already used) as the per-request path for a
SOCKS proxy. We own the local socket in every case, so we keep owning the byte relay.

## Goal

A **type** on each tunnel — `local` (today's behaviour, the default), `remote`, or
`dynamic` — with the engine, editor, validator, resolver-summary, and Monitoring view all
adapting to it. Existing tunnels are unchanged (they migrate to `type: "local"`), the
host-key TOFU path and stats are reused unchanged, and no new runtime dependency is added
(the SOCKS5 handshake is a few dozen lines we own).

## Design decisions (settled — do not relitigate)

- **One discriminant field: `type`.** `tunnel.type: "local" | "remote" | "dynamic"`,
  defaulting to `"local"`. `schemaVersion` bumps **2 → 3**; the migration stamps every
  existing tunnel `type: "local"` (idempotent, no other change). The resolver
  (`store/resolve.js`) is where each type maps to an engine-shaped def, so `validate.js`,
  the editor, and `summariseRoute` all read one source of truth.
- **Field reuse, not new nesting.** Reuse existing fields per type rather than inventing
  parallel structures:
  - **local** — unchanged: `bindHost:localPort` → `destination{host,port}` via the chain.
  - **remote** — `destination{host,port}` is the **local** target the far end forwards back
    to (defaults to `127.0.0.1`); a new `remoteBind{host,port}` names the port bound **on
    the SSH server** (host defaults to `127.0.0.1`; a non-loopback bind is a warned opt-in
    that also needs the server's `GatewayPorts`). `localPort` is unused for remote.
  - **dynamic** — only `bindHost:localPort` (the local SOCKS listener); `destination`,
    `sshHost`/bastion override, and `remoteBind` are unused/hidden. The chain still ends at
    `sshHost || (there is no destination box)` — for dynamic the **SSH server itself** is
    the exit vantage, so `sshHost` is required (there is no destination to imply it from).
- **We own the SOCKS5 server; no library.** A minimal `socks5.js` in main handles the
  SOCKS5 greeting (no-auth only) and a **CONNECT** request to a domain/IPv4/IPv6 target,
  then hands `(dstHost, dstPort, socket)` to the engine, which `forwardOut`s through the
  existing chain and relays. `BIND`/`UDP ASSOCIATE` are rejected with the correct SOCKS
  reply. This mirrors "we never shell out to system `ssh`" — we don't shell out to a SOCKS
  proxy either.
- **Idle/linger semantics per type (settled):**
  - *local* — unchanged (lazy connect on first access, linger teardown).
  - *dynamic* — **lazy** like local: the local SOCKS listener binds on arm; the SSH chain
    connects on the first CONNECT and idle-tears-down after `lingerMs` when no SOCKS
    connections remain. `keepAlive`/`autoReconnect` apply unchanged.
  - *remote* — **eager**: the remote listener only exists while the SSH connection is up, so
    an armed remote tunnel connects the chain immediately and holds it (it behaves like
    `keepAlive` regardless of the flag); `lingerMs` does not apply. On an unexpected drop the
    existing backoff-reconnect path re-establishes it (Feature 130 refines the policy).
- **Host-key verification and stats are reused verbatim.** Every type walks the same
  `ssh-chain.js` + `host-verifier.js` TOFU path, and every relay increments the same
  `stats.js` counters (a SOCKS relay counts up/down like any other; a remote relay counts
  in the natural direction). No new security surface.
- **The renderer never sees a raw socket or a secret.** Same as today: SOCKS parsing, the
  reverse relay, and forwarding all live in main; the renderer only edits the reference
  definition and reads state/stats.

## Data model (v3)

```
tunnel {
  …existing…,
  type: "local" | "remote" | "dynamic",   # NEW, default "local"
  remoteBind?: { host, port },             # NEW, remote only (host defaults 127.0.0.1)
}
```

`routeSummary` gains a type-prefixed shape (single source in `summariseRoute`):
`:5432 → db:5432` (local) · `R remote:8080 ← :3000` (remote) · `SOCKS5 :1080 via bastion`
(dynamic).

## Implementation steps

1. **Model + migration.** Add `type` (+ `remoteBind`) to the tunnel schema and
   `validate.js` (type-specific required/forbidden fields, port ranges, the non-loopback
   `remoteBind` warning, and the "dynamic requires an SSH server" rule). `migrations.js`
   v2→v3 stamps `type: "local"`. Keep `validate.js`/`validate.parity` in lockstep with the
   renderer copy.
2. **Resolver.** In `store/resolve.js`, branch `resolveDefinition` on `type` to emit the
   engine def each type needs (local unchanged; remote adds `remoteBind` + local target;
   dynamic marks a SOCKS listener with no destination). Extend `summariseRoute`.
3. **SOCKS5.** New `src/app/tunnel/socks5.js`: a pure handshake state machine
   (`greeting → request`) returning `{ dstHost, dstPort }` and exposing helpers to write the
   success/failure replies. Unit-test the byte-level parsing/replies (no sockets).
4. **Reverse relay.** In `ssh-chain.js` add `forwardIn(client, host, port)` (promisified)
   and expose the last-hop client's `"tcp connection"` events; in `relay.js` add a reverse
   relay that, per incoming remote connection, dials the local target and pipes both ways
   with stats. Add a `socksRelay` path (accept → parse via `socks5.js` → `forwardOut` → pipe).
5. **Engine/tunnel.** Teach `tunnel.js` the three lifecycles: local (unchanged), dynamic
   (SOCKS listener + lazy connect + linger), remote (eager connect + `forwardIn`, no linger,
   torn down on disarm/drop). `engine.js` needs no new public surface — `arm/disarm/status/
   pause/resume/apply` cover all three; pause on remote stops accepting remote connections,
   pause on dynamic stops accepting SOCKS connections.
6. **Editor UI.** In `tunnel-editor-dialog.js` add a **type** segmented control at the top;
   show/hide/relabel fields per type (remote reveals `remoteBind` + relabels destination as
   "Local target"; dynamic hides destination and requires the SSH server). Reuse the existing
   address parsing (`address.js`) and inline validation.
7. **Monitoring.** `tunnel-table.js`/`tunnel-list.js`/`tunnel-detail.js` show a type badge and
   type-appropriate labels (a dynamic row shows active SOCKS connections; a remote row shows
   the remote bind). No new stats fields.
8. **i18n + docs.** Add the new labels/warnings to `EN` in `i18n.js`, regenerate `en.json`
   (byte-identical test), and update the user guide: extend `docs/defining-tunnels.md` and add
   the type explanations (local/remote/dynamic) — update **both** `docs-viewer.js` and
   `build-docs.mjs` `PAGES` if a new page is added.
9. **Tests + license headers.** `socks5.test.js` (parser/replies), engine tests for a remote
   forward and a dynamic SOCKS request over the in-process harness, resolver + validate cases
   per type, migration v2→v3. Fold into `make test`; header-stamp new files.

## Acceptance criteria

- A **local** tunnel behaves exactly as before; an existing config loads and arms unchanged
  after the v2→v3 migration (all stamped `type: "local"`).
- A **remote** tunnel binds a port on the SSH server and forwards incoming connections to the
  configured local target; it connects eagerly on arm and re-establishes on drop.
- A **dynamic** tunnel exposes a working local SOCKS5 proxy: a client configured to use it can
  reach an arbitrary host reachable from the far end; the SSH chain connects lazily and
  idle-tears-down after linger.
- All three types verify host keys through the existing TOFU prompt and report live stats
  (rates/totals/active connections) in Monitoring.
- No new npm dependency; no secret or raw socket crosses IPC; `make fmt && make lint &&
  make test` green with new tests and headers.

## Constraints

- SOCKS5 is **CONNECT + no-auth only**; BIND/UDP and auth methods are rejected with correct
  replies (documented). No SOCKS library.
- Remote non-loopback binds are a warned opt-in and honestly documented as requiring server
  `GatewayPorts` — Port Hippo cannot make a server accept them.
- All forwarding/parsing stays in main; the renderer edits references only.
- Keep the model/migration behaviour-preserving: no field renames, additive only.

## Verify

```
make fmt && make lint && make test
make debug   # 1) existing local tunnels still arm/forward unchanged.
             # 2) create a dynamic tunnel; point `curl --socks5 127.0.0.1:<port>` at a host
             #    reachable from the far end and confirm it loads; watch lazy connect + linger.
             # 3) create a remote tunnel; from the SSH server connect to its bound port and
             #    confirm it reaches the local target; kill the SSH link and confirm reconnect.
             # 4) confirm host-key TOFU prompts on first use for each type.
```
