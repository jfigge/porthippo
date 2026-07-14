# Tunnel address fields — reference

Reference for the three address:port fields in the tunnel editor (the "Edit
tunnel" dialog). Written to seed the user guide (Feature 80). Each field is a
single free-text input parsed by `src/web/scripts/address.js`; the parsed
host/port land in the existing data-model fields, and the raw string is also
stored verbatim so the editor re-displays exactly what was typed.

A tunnel reads end to end as: **Entry port** (local listener) → *[jump hosts]* →
**Target server** (the SSH box) → **Exit port** (where it forwards on that box).

```
 this machine                              target server
 ┌───────────────┐        SSH         ┌──────────────────────┐
 │  Entry port   │ ─────────────────▶ │  Target server       │
 │ bindHost:     │                    │  sshHost:sshPort      │
 │ localPort     │                    │        │             │
 └───────────────┘                    │        ▼             │
                                      │  Exit port           │
                                      │  destination.host:.port
                                      └──────────────────────┘
```

---

## Entry port

- **Label / hint:** "Entry port" — *local port or address:port*
- **Description (tooltip):** The local address that represents the entry point of
  the tunnel on this machine.
- **Data model:** `bindHost` (only stored when non-loopback) + `localPort`.
- **Raw echo:** `entryAddress`.
- **Fills one line.** Mandatory.

**Accepted input**

| Input            | host            | port  |
|------------------|-----------------|-------|
| `5432`           | `127.0.0.1`     | 5432  |
| `127.0.0.1:5432` | `127.0.0.1`     | 5432  |
| `0.0.0.0:80`     | `0.0.0.0`       | 80    |
| `db.internal`    | — (error: needs a port) |

**Rules**

- A bare port assumes `127.0.0.1`. An address must be given as `address:port`.
- The port must be in range (1–65535). *Checked immediately.*
- If an address is given it must resolve **locally** to a loopback address,
  `0.0.0.0`, or one of this machine's own interface IPs — it cannot point off-box.
  *Checked on save (or test)* via `resolve:bindcheck` → `classifyBindHost`.
- **Warnings** (soft — never block the save):
  - The port conflicts with another tunnel's Entry port.
  - The port is below the OS-restricted range (usually 1024): Port Hippo must run
    as **root** (macOS/Linux) or **Administrator** (Windows) to open it.
  - The address doesn't name a bindable local address.

## Target server

- **Label / hint:** "Target server" — *destination server and ssh port*
- **Description (tooltip):** The remote server the tunnel connects to over SSH —
  the far end.
- **Data model:** `sshHost` (mandatory) + `sshPort` (only stored when explicit).
- **Raw echo:** none — reconstructed from `sshHost[:sshPort]` on load.
- **Fills one line.** Mandatory.

**Accepted input**

| Input                | host             | SSH port |
|----------------------|------------------|----------|
| `db.example.com`     | `db.example.com` | 22 (default) |
| `db.example.com:22`  | `db.example.com` | 22       |
| `bastion:2222`       | `bastion`        | 2222     |

**Rules**

- Host is mandatory; a bare host uses SSH port **22**. A port, if given, must be
  in range. *Port checked immediately.*
- A host **name** (not an IP) is resolved *on save (or test)*: from **this
  machine** when there are no jump hosts, otherwise from the **last jump host**.

## Exit port

- **Label / hint:** "Exit port" — *Optional address:port*
- **Description (tooltip):** An optional local address and port on the target
  server that the tunnel connects to.
- **Data model:** `destination.host` + `destination.port` (always concrete).
- **Raw echo:** `exitAddress` (stored only when non-blank).
- **Fills one line.** Optional.

**Accepted input**

| Input            | host                | port                    |
|------------------|---------------------|-------------------------|
| *(blank)*        | `127.0.0.1`         | the Entry port          |
| `5432`           | `127.0.0.1`         | 5432                    |
| `db.local`       | `db.local`          | the Entry port          |
| `127.0.0.1:5432` | `127.0.0.1`         | 5432                    |

**Rules**

- Blank → `127.0.0.1` and the same port as the Entry port.
- A host on its own reuses the Entry port; a port on its own uses `127.0.0.1`.
- The port, if given, must be in range. *Checked immediately.*
- If a host is given it must resolve **on the target server** and be one of its
  interfaces, `0.0.0.0`, or a loopback address. This can only be validated once
  the Target server (and any jump hosts) are set, and is done *on save (or test)*
  as a **reachability** probe: the editor asks the target server to open a
  `direct-tcpip` channel to the Exit address (`resolve:test` → the engine's
  disposable probe). It is protocol-only — no command is ever run on the remote
  host — so it confirms reachability rather than enumerating remote interfaces.

---

## Notes

- The old standalone **SSH server** / **SSH port** and **Bind address** inputs are
  gone: that information is now the Target server and the Entry port respectively.
- No schema migration ships with this change. Tunnels saved before it still arm
  (the resolver keeps its blank-`sshHost` fallback); when re-opened in the editor
  their fields are reconstructed on a best-effort basis and re-saved in the new
  shape.
