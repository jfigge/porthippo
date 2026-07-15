# Troubleshooting

When a tunnel won't arm or connect, it enters the **Error** state and records a
reason. Open the tunnel (or click its **Errors** card) to read the message and
recent history. Here are the common causes and fixes.

## "Port already in use" (can't arm)

Arming binds the entry port, and only one program can bind a given
`address:port`. If Port Hippo reports the port is in use:

- Another app (or another Port Hippo tunnel) already holds it. Pick a different
  **entry port**, or free the one that's taken.
- Port Hippo tells you *which* of your own tunnels owns a conflicting port when it
  can.
- Find the holder with `lsof -iTCP:5432 -sTCP:LISTEN` (macOS/Linux) or
  `netstat -ano | findstr :5432` (Windows).

## Privileged ports (below 1024)

Binding a port **under 1024** (e.g. 80, 443) requires elevated privileges on
macOS and Linux. If you see a permission error when arming such a port:

- Prefer a **high port** (≥ 1024) as the entry port and point your client at it —
  simplest and safest.
- Or run Port Hippo with the privileges needed to bind low ports (not
  recommended for a background app).

## Connection failures

If the entry port binds but the SSH connection fails on first access, the tunnel
goes to **Error**. Typical reasons:

- **Connection refused / timed out** — the target server or a jump host isn't
  reachable. Check the address and SSH port, your network/VPN, and any firewall.
  Use **Test resolution** in the editor to see which hop fails.
- **Authentication failed** — wrong username, key, passphrase, or password; or the
  server doesn't accept that key. Confirm the credential (see
  [Authentication](authentication.md)); for agent auth, check `ssh-add -l`.
- **Host couldn't be resolved** — a hostname in the chain doesn't resolve on this
  machine. Fix DNS, or the host may only resolve from *inside* the chain (in which
  case it's the **exit port / destination**, resolved from the far end — not the
  local machine).

## "Host key changed" — refused connection

Port Hippo **refuses** a connection when a host's key differs from the one you
trusted. This is a safety stop, not a bug. Do not bypass it blindly:

1. Confirm with whoever runs the server that the key legitimately changed (rebuild,
   key rotation).
2. Only then revoke the old trusted key so the next connection re-prompts, and
   trust the new fingerprint.

See [Host Keys & Trust](host-keys.md).

## Reconnects and drops

If a live connection drops:

- With **auto-reconnect off** (the default), Port Hippo returns the tunnel to
  **Listening** and re-opens it on the next access — no wasted reconnect attempts.
- With **auto-reconnect on**, it re-establishes the connection immediately, backing
  off between attempts so it doesn't hammer a server that's down.

While a tunnel is backing off, the **Reconnect** field (add it from **Data
Fields**, or read it in the list view) shows the current attempt and a live
countdown to the next try; the tray icon and its menu summarise the overall health
(reconnecting, or a bang badge when a tunnel needs attention). A tunnel that
exhausts its attempts stops in **Error** with a **Retry now** button.

Repeated drops usually point at an unstable network path or an idle-timeout on the
server; consider **Keep SSH connected while armed** for a destination you use
constantly. See [Defining Tunnels](defining-tunnels.md).

### Detecting a dead connection quickly (SSH keepalive)

A connection can go *silently* dead — the network path drops without a clean close,
so nothing is delivered and nothing errors until the operating system's TCP timeout
finally expires (which can be minutes). Port Hippo's **SSH keepalive** sends a small
probe over each hop on an interval; if several probes go unanswered the connection
is treated as dropped and the reconnect policy kicks in — turning minutes of silent
limbo into seconds. Tune it under **Settings → Notifications** (*SSH keepalive
interval*; `0` turns probing off).

> **Keepalive vs. keep-alive.** These are two different things. **SSH keepalive**
> (Settings) is the *health probe* described above. **Keep SSH connected while
> armed** (per tunnel) instead holds the SSH connection open the whole time the
> tunnel is armed, instead of opening it lazily and tearing it down when idle.

### Tuning the retry policy

The reconnect backoff is configurable globally under **Settings → Notifications**:

- **Reconnect base backoff** — the first delay after a drop; it doubles each attempt.
- **Reconnect max backoff** — the ceiling that doubling delay is clamped to.
- **Reconnect attempts before giving up** — how many tries before a tunnel stops in
  **Error**. (Tunnels set to *Keep SSH connected while armed* never give up — they
  keep retrying at the max backoff until they reconnect or you disarm them.)

A single tunnel can override any of these in the editor's **Advanced → Reconnect
policy** section; leave a field blank to inherit the global value.

## Failure notifications

Port Hippo can raise a desktop notification when a tunnel **drops**, **recovers**,
or **gives up**, and always when a host **key changes**. Notifications carry only
the tunnel's name — never a host, username, or secret. They're coalesced so a
flapping tunnel can't spam you (a *recovered* notice appears only if you were told
about the drop, and repeated drops are held back by a cooldown). Turn the whole set
off, toggle individual events, or change the cooldown under **Settings →
Notifications**. Your operating system's Do-Not-Disturb is always respected.

## Secrets are locked (master password)

If you use the **master password** backend, Port Hippo starts locked and can't
decrypt credentials until you unlock it. Tunnels that need a stored secret wait
until you enter the password (**Settings → Security**, or the unlock prompt at
launch). See [Security](security.md).

## Still stuck? Collect diagnostics

**Help → Copy Diagnostics** puts a redacted report on your clipboard (app info,
tunnel list without secrets, and a redacted log tail). **Help → Show Logs Folder**
opens the rotating log. Both are safe to share on a
[GitHub issue](https://github.com/jfigge/porthippo/issues) — secrets are stripped.
