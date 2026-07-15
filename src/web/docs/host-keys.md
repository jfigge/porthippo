# Host Keys & Trust

Authentication proves *you* to the server. **Host-key verification** proves the
*server* to you — it's how you know you're really talking to `bastion.example.com`
and not an impostor intercepting the connection. Port Hippo verifies the host key
of **every** hop in a tunnel: each jump host and the target server.

## How verification works

For each hop, Port Hippo checks the server's presented host key against:

1. your `~/.ssh/known_hosts` file, and
2. Port Hippo's own accepted-keys store.

There are three outcomes:

- **Known and matching** → the connection proceeds silently. This is the normal
  case.
- **Unknown** (never seen this host) → Port Hippo prompts you to trust it — see
  Trust on first use below.
- **Changed** (known host, *different* key) → Port Hippo **refuses** the
  connection and warns you. It never auto-accepts a changed key.

Port Hippo **never** connects to a server it can't verify without asking you
first.

## Trust on first use (TOFU)

The first time you connect to a host, there's nothing to check against yet, so Port
Hippo shows you the key's **fingerprint** and asks whether to trust it. This is the
same trust-on-first-use model as the `ssh` command's "The authenticity of host …
can't be established" prompt.

- **Trust** — Port Hippo records the fingerprint in its accepted-keys store and
  continues. Future connections to that host are silent.
- **Reject** — the connection is abandoned.

Ideally you verify the fingerprint out of band (from your server provider or admin)
before trusting it. In practice, on a network you control, the first-connection
prompt is your baseline.

The same prompt appears during **Test resolution** — testing a chain trusts hosts
exactly as arming would.

## What a "changed key" warning means

If a host you've already trusted presents a **different** key, Port Hippo stops and
warns you. There are two explanations:

1. **Legitimate** — the server was rebuilt, its host key was rotated, or you're
   connecting to a different machine behind the same name.
2. **An attack** — someone is intercepting the connection (a man-in-the-middle)
   and presenting their own key.

Port Hippo can't tell these apart, so it **refuses to connect** and leaves the
decision to you. Do **not** dismiss this lightly:

- Confirm with whoever runs the server that the key genuinely changed.
- Only after you've verified the new fingerprint out of band should you clear the
  old key and re-trust.

## Managing trusted keys

**Settings → Host Keys** lists the fingerprints Port Hippo verifies against, split
across two tabs:

- **Port Hippo** — the keys you accepted through Port Hippo (its own accepted-keys
  store, kept separately from `known_hosts`). These you can manage: **forget** a key
  so the next connection to that host re-prompts — useful after a legitimate key
  rotation, or to force a re-check.
- **Operating System** — the keys already in your `~/.ssh/known_hosts`. Port Hippo
  reads and verifies against these but **can't change them** — that file is owned by
  your OS / OpenSSH. This tab is read-only and shows where the file lives; edit it
  yourself (for example with `ssh-keygen -R <host>` to drop a key) to manage them.

## Why this matters

Port Hippo carries your SSH credentials to these servers. If it authenticated to an
impostor, your credentials could be captured. Host-key verification is what
prevents that — which is why a changed key is a hard stop, not a warning you can
wave away. See the [Security](security.md) page for the full picture.
