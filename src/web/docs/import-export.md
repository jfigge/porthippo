# Import & Export

Everything you build in Port Hippo — tunnels, reusable credentials, and jump-host
chains — normally lives only on the machine you built it on, encrypted for *that*
device. The **Import/Export** tab in Settings lets you move a setup between
machines, keep a backup, and seed a fresh install from your existing
`~/.ssh/config`.

Open it from **Settings → Import/Export**.

## The `.porthippo` bundle

A **bundle** is a single self-describing file containing your tunnels, credentials,
and jump hosts (and, optionally, your app settings). It's the unit of backup and of
moving to a new machine.

### Exporting

**Settings → Import/Export → Export bundle…** lets you choose:

- **Include app settings** — carry your preferences (theme, language, defaults)
  into the bundle. Device-specific things (window size, launch-at-login) are never
  exported.
- **Secrets** — how passwords and key passphrases are handled:
  - **Don't include passwords** (the default, and the safest). The bundle carries
    no secrets; imported credentials will need their passwords re-entered.
  - **Protect with a passphrase** — encrypt the secrets with a passphrase you
    choose. You'll need that same passphrase to import them.

Then pick where to save the `.porthippo` file.

> **Why secrets aren't just copied.** Port Hippo seals secrets at rest with a key
> that's bound to *this* device (or your OS keychain, or your master password) — so
> the sealed form deliberately **won't decrypt anywhere else**. Export therefore
> uses its own portable, passphrase-based encryption instead of copying the
> device-sealed blob. A plaintext password is never written to disk.

### Importing

**Settings → Import/Export → Import bundle…** — pick a `.porthippo` file and Port Hippo
shows you a **preview** before anything changes: how many tunnels, credentials, and
jump hosts are **new**, an **update** to something you already have, or a
name **conflict**. Choose how to apply it:

- **Merge** (default) — add what's new and keep what you already have. Existing
  secrets are **never** overwritten by an import, and a tunnel whose name collides
  is imported under a new name so nothing is lost.
- **Replace everything** — delete all your current tunnels, credentials, and jump
  hosts, then load the bundle. Use this to restore a machine to a known state.

If the bundle was exported with a passphrase, you'll be asked for it. A wrong
passphrase fails cleanly — nothing is changed. A bundle that's internally
inconsistent is rejected whole, never half-applied.

### Moving to a new machine

1. On the old machine: **Export bundle…**, choosing *Protect with a passphrase* if
   you want your secrets to come across.
2. Copy the `.porthippo` file to the new machine (any way you like).
3. On the new machine: **Import bundle…**, enter the passphrase, and choose
   **Merge** (or **Replace everything** for a fresh install).

Imported secrets are immediately re-sealed under the **new** machine's own storage
backend, so they sit alongside everything else exactly as if you'd typed them there.

### Credentials that "need password"

If you imported a bundle **without** its secrets (the stripped default), any
password credential arrives flagged **needs password**. It appears that way in the
credential picker and editor, and a tunnel using it can't connect until you open
the credential and re-enter the password.

## Importing from your SSH config

If you already keep hosts in `~/.ssh/config`, **Settings → Import/Export → Import
from SSH config…** proposes Port Hippo records from it — no retyping.

Port Hippo reads the common directives — `Host`, `HostName`, `User`, `Port`,
`IdentityFile`, `ProxyJump`, and `Include` — and proposes, for each host:

- a **credential** (an *agent* credential, or a *key* credential pointing at the
  `IdentityFile` — only its **path** is read, never the key's contents),
- **jump hosts** for any `ProxyJump` chain, and
- a **tunnel** draft that connects to that host.

Nothing is written until you tick the hosts you want and confirm. Each selected
host also brings in the credential and jump hosts it needs.

> **The drafted tunnels are a starting point.** An SSH config says how to *reach* a
> server, not what to *forward* — so each drafted tunnel gets a placeholder local
> port and destination. Open it in the editor afterwards and set the forwarding you
> actually want. Passwords are never invented: a host with no key maps to an agent
> credential.

## Security notes

- **No plaintext secret ever touches disk** — not in a bundle, not during an
  import. Passphrase-protected bundles use PBKDF2 + AES-256-GCM; the passphrase is
  never stored.
- **Import never silently overwrites.** It's a reviewed merge or an explicitly
  confirmed replace, and a stripped import can't clobber a secret you already have.
- **The SSH-config importer is read-only** and never runs anything — it only reads
  the config file's text and your key *paths*.

See also [Authentication](authentication.md), [Jump Hosts](jump-hosts.md), and
[Security](security.md).
