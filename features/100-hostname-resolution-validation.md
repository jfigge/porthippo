# Feature 100 — Hostname resolution validation (local warnings + Test-resolution through the chain)

> Status: **implemented** — main-side resolver/probe, IPC, and editor UI landed; `make fmt && lint && test` green (+15 new tests). Pending: the manual `make debug` pass in **Verify** (real SSH chain + host-key prompts), then move this file to `features/done/`.

## Context

Every host a tunnel names is resolved from a **different vantage point**, which the
Feature 20 chain makes literal (`ssh-chain.js`): the first hop connects over plain TCP, so
it resolves **locally**; each later hop is reached by `forwardOut` **from the previous hop**,
so it resolves **there**; the destination is `forwardOut`-ed **from the SSH server**. The
resolver (`store/resolve.js`, Feature 45) turns a reference tunnel into the engine-shaped
`{ destination, sshServer, jumps }` the chain consumes.

Today the editor never checks whether any of these names resolve. A typo in a hostname only
surfaces at arm time as an opaque connect failure. We want to catch it in the editor — but a
naïve *local* DNS check on the **destination host** would be actively misleading: an internal
name like `db.internal` legitimately resolves **only on the far side**, so a local "can't
resolve" warning there would be pure noise. Resolvability is only meaningful **from the vantage
point that will actually resolve the name.**

This stage adds resolvability feedback split along exactly that seam: cheap **local** warnings
for the names resolved from this machine, and an explicit **Test resolution** action that walks
the real chain to validate every downstream hop — and the destination — from where each is
actually resolved. Doing so also *validates each jump host* (you cannot resolve hop *n+1*
without successfully connecting through hop *n*), which is what the request asks for.

**Prerequisites:** **Feature 20** (`ssh-chain.js` `connectChain`/`forwardOut`, the
`TunnelEngine` host-key TOFU mediation — `hostVerifierFactory`, `porthippo:hostkey-unknown`,
`hostkeys:trust|reject`, `trustHostKey/rejectHostKey`) and **Feature 45** (`store/resolve.js`,
the `TunnelEditorDialog`, reusable `credentials[]` / `jumpHosts[]`, the soft-warning pattern —
`editor-bind-warning` / `editor-port-warning`). No new dependency; `dns` and `ssh2` are already
in main.

## Goal

In the tunnel editor:

- Names resolved **from this machine** — the **bind host** and the **first hop** (the first
  jump host, or, with no jumps, the SSH server / destination box the resolver implies) — get a
  live, **soft, non-blocking** warning if DNS can't resolve them, mirroring the existing
  bind/port warnings. IP literals and empty fields are skipped.
- A **Test resolution** button connects the **actual chain** (jumps → SSH server) and then
  probes the **destination** from the far end, reporting **per-hop** pass/fail with the reason.
  Reaching hop *n+1* proves hop *n* resolved, authenticated, and passed host-key verification —
  so the run doubles as a chain/jump-host test. It reuses the engine's host-key TOFU prompt
  unchanged, so an unknown key during a test prompts exactly as arming would (and the accepted
  key is persisted for the later real connection).

All feedback is **advisory** — a failing resolution never blocks Save (the far side may simply
be down right now). No secret ever leaves main; the probe never leaves a connection or listener
behind.

## Design decisions (settled — do not relitigate)

- **Two tiers, split by vantage point.**
  - **Local (live, no SSH):** `dns.lookup` in main on the names this machine resolves — the
    **bind host** and the **first hop**. The first hop is the resolver's `hop[0]`: the first
    `jumpHostIds` entry's `host` if any; otherwise the SSH server host, which is `sshHost` or,
    when blank, `destination.host` (the "SSH into the destination box" implication). Reuse
    `store/resolve.js`'s implication rules to pick it — **never** re-derive them in the editor,
    so display can't drift from behaviour. Debounced; IP literals and blanks short-circuit to
    "ok" without a lookup.
  - **Remote (explicit, SSH):** everything downstream of the first hop only resolves from a
    remote vantage, so it is **never** checked live — only by the **Test resolution** button.
- **Remote resolution = an SSH `direct-tcpip` (`forwardOut`) probe, never remote command
  execution.** To validate a name *from a hop*, ask that hop's SSH server to open a
  `direct-tcpip` channel to the target `host:port` (exactly what the tunnel does at runtime) and
  immediately close it — success ⇒ the far side resolved **and** could reach it. This is
  **protocol-only**: no shell on the remote host, so **no command-injection surface** from a
  crafted hostname and **no dependency on remote tooling** (`getent`/`nslookup`). It validates
  the *real* path, not a proxy for it. Honest limitation, stated in the UI copy: an SSH server
  reports DNS-failure and connection-refused **both** as "connect failed", so we surface the
  server's reason text and frame a failure as *"couldn't reach `<host>:<port>` from `<hop>`"*
  rather than asserting "DNS failed" specifically. (For a tunnel, reachability is the more
  useful signal anyway.) The probe channel is closed immediately and never relays a byte.
- **The chain does most of the work for free.** `connectChain` already resolves+reaches each
  hop from the previous one (its per-hop `forwardOut` to `next.host:next.port`). So a Test run
  is: **build the chain**, then **one extra `forwardOut` to `destination.host:destination.port`**
  from the final client. A hop that fails to build *is* the resolvability/reachability failure
  for that hop, reported with its `hopError` label.
- **Reuse the engine's host-key TOFU mediation verbatim.** The probe runs through the same
  `hostVerifierFactory` → `porthippo:hostkey-unknown` → `hostkeys:trust|reject` flow, resolved
  by the existing `host-key-prompt.js` renderer component. No new prompt UI; a key accepted
  during a test is persisted, so the subsequent real arm won't re-prompt — this is what makes
  the test genuinely *validate* the jump host.
- **A dedicated, disposable probe path in the engine — not `arm()`.** Add
  `engine.probeDefinition(payload, { signal })`: resolve the **draft reference payload** (from
  the editor's `buildPayload()`) to engine shape via `store/resolve.js`, decrypting referenced
  credentials **in main**; `connectChain`; `forwardOut`-probe the destination; then **always
  `dispose()`** every hop. It must **never** touch the engine `#tunnels` map, bind a local port,
  or leave a socket open. Time-boxed (a per-run timeout) and **cancellable** (an `AbortSignal`
  that disposes the in-flight chain). One probe at a time per editor (a new run cancels the
  prior). The payload may be **unsaved/new** (no `id`) and reference existing credentials/jump
  hosts — resolve refs against the live stores.
- **Advisory, never blocking.** Neither the local warnings nor a failed Test run adds a
  `validateDefinition` error or prevents Save — same posture as the privileged-port / port-clash
  warnings. Resolution status is not persisted.
- **Renderer stays sandboxed and secret-free.** It sends only the draft **reference** payload
  (ids + hosts + ports — no secrets) and bare hostnames for local lookup; it receives only
  `{ resolved, address?, family?, reason? }` and a per-hop `{ hopLabel, host, port, status,
  reason? }` list. Credential decryption and every socket live in main.

## Implementation steps

1. **Local lookup in main — `src/app/tunnel/resolve-check.js`** (new; keep it off the hot
   engine path). Export `lookupHost(host, { lookup = dns.lookup } = {})` →
   `{ resolved: boolean, address?, family?, reason? }`: trim; empty ⇒ `{ resolved: true }`
   (nothing to warn); an IP literal (`net.isIP`) ⇒ `{ resolved: true, address: host }` without a
   lookup; otherwise `dns.lookup(host, { all: false })`, mapping `ENOTFOUND`/`EAI_AGAIN` to
   `{ resolved: false, reason }`. Inject `lookup` for tests.
2. **Engine probe — `TunnelEngine.probeDefinition(payload, { signal })`** in
   `tunnel/engine.js` (reusing `#buildHostVerifier`/`#requestTrust`, so host-key prompts flow as
   normal). Resolve `payload` to `{ destination, sshServer, jumps }` with the same
   decrypt-then-`resolveDefinition` path `getDecrypted` uses; `hops = [...jumps, sshServer]`;
   `connectChain({ hops, tunnelId: payload.id ?? "probe", hostVerifierFactory, readFileSync })`;
   on success `forwardOut(client, "127.0.0.1", 0, destination.host, destination.port)` then end
   the stream; **`finally` → `dispose()`**. Honour `signal` (abort ⇒ dispose ⇒ reject) and a
   `PROBE_TIMEOUT_MS`. Return `{ ok, hops: [{ hopLabel, host, port, status:"ok"|"fail",
   reason? }], destination: { host, port, status, reason? } }` — a hop that fails to build
   reports `status:"fail"` with its `hopError` message and the run stops there (downstream hops
   report `status:"skipped"`). Never mutate `#tunnels`.
3. **IPC — `src/app/ipc/resolve.js`** (new): `registerResolveIPC({ ipcMain, getEngine,
   safeCall })` exposing `resolve:lookup` (`{ host }` → `lookupHost`), `resolve:test`
   (`{ payload }` → `getEngine().probeDefinition`, tracking the run's `AbortController`), and
   `resolve:cancel` (aborts the in-flight run → `{ ok }`). Register in `main.js`; **add
   `ipc/resolve.js` to the `ipc-parity.test.js` scan list.** Host-key prompts already broadcast
   from the engine — no new channel.
4. **`preload.js`** — expose `window.porthippo.resolve.{ lookup(host), test(payload), cancel() }`
   mirroring the channels (keep handler ↔ exposure in lockstep).
5. **Editor — live local warnings** in `components/tunnel-editor-dialog.js`. Add soft-warning
   `<p>` elements (styled like `editor-bind-warning`) for the **destination host** and, in
   Advanced, the **bind host** and **first-jump/SSH-server** host. On a debounced `input`
   (and on load / picker change), compute the first-hop host via the resolver's implication and
   call `resolve.lookup` for each **local-vantage** name; show/hide the warning from `resolved`.
   Skip when the field is empty or an IP literal. Purely additive to the existing
   `#updateBindWarning`/`#updatePortWarning` — **never** feeds `validateDefinition`.
6. **Editor — Test resolution.** Add a **Test resolution** button (in the Advanced footer, near
   the jump-host chain). On click: build the draft `buildPayload()`, disable the button + show a
   spinner, `resolve.test(payload)`, and render a per-hop result list (✓/✗ + reason, plus the
   destination row). A second click while running **cancels** (`resolve.cancel`). Unknown
   host keys surface through the existing `host-key-prompt.js` component untouched. Results are
   advisory and cleared on any field edit. All copy via `t()`.
7. **i18n.** Add `editor.resolve.*` keys to `EN` in `src/web/scripts/i18n.js` (button label,
   running/cancel, the "resolves only on the far side" hint, per-status row text, the
   local-unresolved warning, the reach-failure framing), then **regenerate `en.json`**
   (`cd src && node --input-type=module -e "import {EN} from './web/scripts/i18n.js'; import {writeFileSync} from 'node:fs'; writeFileSync('./web/locales/en.json', JSON.stringify(EN,null,2)+'\n')"`).
8. **CSS.** Add a `.editor-resolve-*` block to `src/web/styles/components.css` for the button,
   spinner, and per-hop result rows, using existing tokens (reuse the warning colours for a
   failed row, `--color-success`/equivalent for a pass). No hardcoded colours/sizes.
9. **Tests.**
   - `resolve-check.test.js`: `lookupHost` with an injected `lookup` — resolves, `ENOTFOUND` ⇒
     unresolved, IP-literal + empty short-circuit (no lookup call).
   - `engine` probe test: inject a fake `connectChain`/`forwardOut` (as `ssh-chain` tests inject
     `readFileSync`) — all hops pass; a mid-chain hop failure stops + labels the failing hop +
     marks downstream skipped; destination-forward failure reported; **`dispose()` always
     called**; abort + timeout paths reject and dispose; `#tunnels` untouched.
   - `ipc-parity` covers `resolve:lookup|test|cancel`; a small reason-shape test for the probe
     result.
   - `tunnel-editor-dialog.test.js` additions (inject a fake `porthippo.resolve`): a local
     warning appears when `lookup` reports unresolved and clears when it resolves; IP literals
     don't trigger a lookup; the Test button calls `resolve.test` and renders the per-hop rows;
     a failed resolution does **not** block Save.
10. **License headers** on new files; update `CLAUDE.md` (tunnel-engine section: the disposable
    `probeDefinition` probe path; a one-line note in the security posture that resolution
    validation is protocol-only — no remote command execution, no secret leaves main).

## Acceptance criteria

- Typing an unresolvable **bind host** or **first hop** shows a soft warning under that field
  within a debounce; fixing it (or entering an IP literal) clears it. Save is never blocked.
- The **destination host** is **not** warned locally (it resolves on the far side); it is
  validated only by Test resolution.
- **Test resolution** connects the real chain and reports **per hop** plus the destination:
  each reached hop is a pass; the first unreachable hop is flagged with the SSH server's reason
  and downstream hops are skipped. An unknown host key prompts via the existing dialog, and
  accepting it persists the key so the subsequent real arm doesn't re-prompt.
- The probe **never** binds a local port, mutates engine tunnel state, or leaves a connection
  open — every hop is disposed on success, failure, cancel, and timeout; a run is cancellable.
- No secret ever crosses IPC; no command is executed on any remote host.
- `make fmt && make lint && make test` green; new files carry the license header; `EN` and
  `en.json` stay byte-identical.

## Constraints

- All DNS and SSH in **main**; the renderer sends only the draft **reference** payload + bare
  hostnames and receives only resolution status (host/port/reason — all non-secret).
- Remote resolution is **protocol-only** (`forwardOut`) — never `client.exec()` a resolver, so
  no shell/injection surface and no remote-tooling dependency.
- Reuse the Feature 20 host-key TOFU mediation and `host-key-prompt.js` unchanged; **never**
  auto-accept a key.
- Resolution feedback is **advisory** — it never adds a `validateDefinition` error, blocks Save,
  or is persisted. Keep it additive to the existing soft-warning code.
- Strings via the `t()` / `en.json` seam; CSS via `theme.css` tokens.

## Verify

`make fmt && make lint && make test`, then `make debug`:

- Enter a bogus **bind host** and a bogus **first jump host** → soft warnings appear; correct
  them → warnings clear; enter an IP literal → no warning, no lookup.
- Build a real chain (a reachable jump host + SSH server + destination) and click **Test
  resolution** → every hop and the destination pass. Point the destination at a bogus name →
  the run passes the hops but flags the destination with the far side's reason. Point a jump
  host at a bogus name → that hop fails and downstream hops are skipped. Delete the jump host's
  accepted key first → Test prompts to trust it, and after accepting, arming the tunnel does not
  re-prompt.
- Cancel a Test mid-run → it stops and leaves no open connection (confirm via Monitoring / logs);
  Save a tunnel whose destination currently fails resolution → the save succeeds.
