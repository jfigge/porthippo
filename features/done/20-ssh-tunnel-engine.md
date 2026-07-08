# Feature 20 — SSH tunnel engine (on-demand forwarding + lifecycle)

## Context
This is the **heart of Port Hippo** and the reason it exists. With definitions persisted
(Feature 10), the engine must implement the product's defining behaviour: bind a local
port, **open an SSH tunnel automatically the moment that port is accessed**, hold it open
while any connection is live, and **tear the SSH connection down once the local port goes
idle** — however long the listener itself stays bound — with optional multi-hop jump-host
chaining.

Node has no built-in SSH, so this stage introduces the project's one essential runtime
dependency: **`ssh2`** (Brian White's pure-JS SSH2 client, the de-facto standard). The
critical architectural choice: we do **not** shell out to the system `ssh -L` binary.
Instead, **we** own the local socket (`net.createServer`) and pipe its bytes through an
`ssh2` `direct-tcpip` channel (`conn.forwardOut`). Owning the data path is what makes the
rest of the product possible — per-connection **byte counting** (Feature 30), **pause**
without teardown (Feature 30), precise **connection ref-counting**, and consistent
cross-platform behaviour — none of which is feasible when an external `ssh` process owns
the socket.

## Goal
A main-process engine that, for each **armed** (enabled) definition, binds a local
listener on `bindHost:localPort`, lazily establishes the SSH connection (through the full
jump-host chain) on first inbound connection, relays bytes to the destination via
`forwardOut`, ref-counts live connections, and tears the SSH connection down after the
configured linger once the last connection closes — verified end-to-end against an
in-process test SSH server.

## Design decisions (settled — do not relitigate)
- **`ssh2`, not system `ssh`.** We own the local socket and relay bytes ourselves. System
  `ssh -L` is rejected: it hides the byte stream (no per-tunnel stats, no pause), needs a
  reliable `ssh` binary + config across macOS/Windows/Linux, and complicates jump-host and
  auth control. Record this trade-off; do not revisit.
- **Lazy connect (on-demand) is the default.** The local listener binds as soon as a
  definition is armed, but the SSH connection is opened **on the first accepted local
  connection**. `keepAlive:true` definitions instead connect eagerly and never idle-tear
  down. This directly implements "automatically connecting when a port is accessed".
- **Connection ref-counting drives teardown.** A counter tracks live relayed connections.
  When it drops to zero, start a **linger timer** (`def.lingerMs`, default from settings).
  A new connection before it fires cancels it; when it fires, end the SSH connection but
  **keep the local listener bound**. This is "hold open while connected, regardless of how
  long the port is bound; clean up when the local port goes idle".
- **Jump hosts chain via `ssh2`'s `sock` option.** Connect an `ssh2.Client` to `jumps[0]`;
  on `ready`, `forwardOut('127.0.0.1', 0, jumps[1].host, jumps[1].port, cb)` yields a
  stream; pass that stream as `sock` to the next `Client.connect`; repeat to the final
  `sshServer`. The final client `forwardOut`s to `destination`. Each hop authenticates
  independently.
- **Host-key verification is mandatory.** `ssh2`'s `hostVerifier` checks each hop's key
  against (a) the user's `~/.ssh/known_hosts` and (b) Port Hippo's accepted-keys store
  (Feature 10). Unknown key → emit `porthippo:hostkey-unknown` to the renderer and hold
  the connection pending until the user trusts (TOFU) or rejects. **Never auto-accept.**
- **Bind loopback by default.** Listener binds `def.bindHost` (default `127.0.0.1`).
- **One engine, many tunnels.** A single `TunnelEngine` singleton owns a `Map<id, Tunnel>`.
  Arming/disarming, reacting to store changes, and clean shutdown on app quit all live here.
- **Everything is in main.** The renderer only sends arm/disarm/status intents over IPC.

## Tunnel state machine (per definition)
`disarmed` → (arm) → `listening` → (first conn) → `connecting` → `connected`
→ (idle > linger) → `listening` (SSH torn down, listener still bound)
→ (disarm) → `disarmed`. Plus `paused` (Feature 30) and `error` (with retry/backoff).

## Implementation steps
1. **Add the dependency.** `ssh2` in `src/package.json` `dependencies` (pin a current
   major). Note its native-free install; verify it packages cleanly in `make build`.
2. **`src/app/tunnel/listener.js`.** Wrap `net.createServer` bound to `bindHost:localPort`.
   Expose `start()`/`stop()`, an `onConnection(socket)` hook, and surface `EADDRINUSE` /
   privileged-port (`<1024` on Unix) errors as structured tunnel errors (no crash).
3. **`src/app/tunnel/ssh-chain.js`.** Given `[...jumps, sshServer]`, build the SSH
   connection by chaining `ssh2.Client`s through the `sock` option as above. Resolve auth
   per hop: `agent` (`process.env.SSH_AUTH_SOCK`, or the OpenSSH/pageant agent on Windows),
   `key` (read `privateKeyPath`, decrypt passphrase from the store, pass to `ssh2`), or
   `password` (decrypted). Try listed methods in order. Apply `hostVerifier` per hop
   (step 6). Return the final connected `Client` + a `dispose()` that ends every hop.
4. **`src/app/tunnel/relay.js`.** Given the final client and a local `socket`, call
   `client.forwardOut(socket.remoteAddress, socket.remotePort, destination.host,
   destination.port, cb)`; on the returned `stream`, `socket.pipe(stream)` and
   `stream.pipe(socket)`; instrument both directions with byte counters (Feature 30 reads
   these); tie lifetimes together (either side `close`/`error` ends the other) and invoke a
   `onClose` callback so the owning tunnel can decrement its ref-count.
5. **`src/app/tunnel/tunnel.js`.** The per-definition state machine tying 2–4 together:
   holds the listener, the (lazily created, shared) SSH connection, the live-connection
   ref-count, and the linger timer. First connection → `connecting` → establish chain →
   `connected` → relay. Ref-count to zero → arm linger timer → on fire, `dispose()` the
   SSH connection and return to `listening`. Handle SSH drop while connections are live
   (fail those connections, attempt a bounded reconnect with backoff, → `error` on
   exhaustion). `keepAlive` connects on arm and skips idle teardown.
6. **`src/app/tunnel/host-verifier.js`.** Parse `~/.ssh/known_hosts` (host/IP + key type +
   base64 key), compute the presented key's fingerprint, and accept if it matches there or
   in the accepted-keys store. On mismatch → hard reject (possible MITM; emit
   `porthippo:hostkey-changed`). On unknown → emit `porthippo:hostkey-unknown`
   `{ tunnelId, hop, fingerprint }` and await an IPC decision (`hostkeys:trust` /
   `hostkeys:reject`), persisting a trust via Feature 10's store.
7. **`src/app/tunnel/engine.js`.** The `TunnelEngine` singleton: `arm(id)`, `disarm(id)`,
   `armAll()`, `status()`, `disarmAll()` (app-quit cleanup). Subscribe to tunnel-store
   changes so edits re-arm affected tunnels. Instantiate in `main.js`; call `disarmAll()`
   on `before-quit`.
8. **IPC + preload.** `tunnels:arm`, `tunnels:disarm`, `tunnels:status`,
   `hostkeys:trust`, `hostkeys:reject` handlers (extend `ipc/store.js` or a new
   `ipc/engine.js`); expose under `window.porthippo.tunnels.*` / `.hostkeys.*`. Broadcast
   `porthippo:tunnel-state` `{ id, state, error? }` on every state change (the monitoring
   view consumes it in Feature 50). Keep main/preload in lockstep.
9. **Tests (integration, in-process).** Add `src/app/tunnel/tests/`: spin up an in-process
   **`ssh2` server** (accepting a fixture key, implementing `direct-tcpip`) plus a plain TCP
   **echo** server as the destination. Assert: (a) arming binds the listener but does *not*
   connect SSH; (b) a client connecting to the local port triggers SSH connect and bytes
   echo through; (c) closing the client and waiting `lingerMs` tears the SSH connection down
   while the listener stays bound; (d) a **two-hop jump chain** (two in-process ssh servers)
   relays end-to-end; (e) an unknown host key holds pending until `trust`; (f) `EADDRINUSE`
   surfaces as an `error` state, not a crash. Wire a `test-tunnel` Make target into `test`.
10. **License headers** on every new file; update `CLAUDE.md`'s architecture section to
    describe the engine and the `src/app/tunnel/` layout.

## Acceptance criteria
- Arming a definition binds `bindHost:localPort` and leaves SSH **disconnected** until the
  port is first accessed.
- Connecting to the local port opens the SSH tunnel (through any jump-host chain) and
  relays traffic bidirectionally to the destination.
- The SSH connection stays up while ≥1 connection is live and is **torn down `lingerMs`
  after the last one closes**, while the listener remains bound; a subsequent access
  re-opens it.
- `keepAlive` tunnels connect on arm and never idle-tear down.
- Unknown/changed host keys are never silently accepted — the user must trust an unknown
  key; a changed key is rejected.
- The integration suite (single-hop relay, multi-hop chain, idle teardown, host-key TOFU,
  `EADDRINUSE`) passes; `make test` green; new files carry the license header.

## Constraints
- All sockets/SSH in **main**; the renderer only sends arm/disarm/trust intents and
  receives `porthippo:tunnel-state` / `porthippo:hostkey-*` events.
- `ssh2` is the only new runtime dependency; do not add per-feature helper libs — parse
  `known_hosts` and count bytes ourselves.
- Bind `127.0.0.1` unless the definition explicitly opts into a wider `bindHost`.
- Never log or emit secrets or private-key material; fingerprints only.
- Reconnect with bounded backoff; never hot-loop on a failing host.

## Verify
`make fmt && make lint && make test`. Then a real end-to-end check: run a throwaway local
SSH server you can reach (or `localhost` sshd), define a tunnel whose destination is some
reachable service, `make debug`, arm it, and confirm (a) `nc`/app access to the local port
opens the tunnel, (b) traffic flows, (c) `porthippo:tunnel-state` transitions
listening→connecting→connected in DevTools, and (d) after closing the client and waiting
the linger, the SSH connection drops while the local port is still bound. Test a jump-host
chain against two hosts if available.
