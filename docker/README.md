# Port Hippo integration-test sandbox

Two Docker containers that model Port Hippo's core scenario — a **jump host** and a
**destination** reachable only through it — so you can exercise real SSH tunnels
(password **and** key auth, single-hop **and** jump-chain) against live sshd
servers instead of mocks.

```
  this machine ──127.0.0.1:2201──▶  jump (172.28.0.11 / 172.29.0.11)
                                       sshd + echo on 127.0.0.1:7000
                                          │  (internal back network only)
                                          ▼
                                     dest (172.29.0.12)
                                       sshd + echo on 127.0.0.1:7000
```

- **jump** is on a host-reachable *front* network **and** an internal *back*
  network. Its sshd is published to `127.0.0.1:2201` on this machine.
- **dest** is on the internal *back* network **only** (`internal: true`), so it has
  no route to the host or the internet — it is reachable **solely from jump**.
- Each container's **echo service binds `127.0.0.1`**, so it is reachable only
  through an SSH forward, never directly. (`socat … EXEC:cat` — send a line, it
  comes back, after a one-line banner naming the container.)

Everything is a **throwaway local test rig** — the credentials are intentionally
weak and must never be exposed.

## Make targets (run from the repo root)

| Target | What it does |
|--------|--------------|
| `make sandbox-create`  | Generate the SSH keypair, build the image, create the containers + networks (not started) |
| `make sandbox-start`   | Start the containers, then print access details |
| `make sandbox-stop`    | Stop the containers (fast restart; state kept) |
| `make sandbox-destroy` | Remove the containers + networks (keeps the image + keys) |
| `make sandbox-verify`  | Prove both echo services are reachable over SSH (direct + via jump) |
| `make sandbox-access`  | Re-print the access details |
| `make sandbox-status`  | `docker compose ps` |
| `make sandbox-logs`    | Follow both containers' logs |

`make sandbox-start` alone also creates anything missing, so the quick path is
`make sandbox-start` → `make sandbox-verify`.

## Credentials

- **User:** `tunnel`  ·  **Password:** `tunnelpass` (both containers)
- **Key:** `docker/keys/id_porthippo` (generated on `sandbox-create`; its `.pub`
  is authorised on both containers). The `keys/` dir is git-ignored.

## Using it from Port Hippo

`make sandbox-start` prints ready-to-enter tunnel definitions for both scenarios
(jump host's own echo; and dest's echo through the jump chain), for password and
for key auth. Host keys change on destroy→recreate, so the first arm after a
recreate raises Port Hippo's trust-on-first-use prompt.
