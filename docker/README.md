# Port Hippo integration-test sandbox

Two Docker containers that model Port Hippo's core scenario — a **jump host** and a
**destination** reachable only through it — so you can exercise real SSH tunnels
(password **and** key auth, single-hop **and** jump-chain, and — since Feature 110
— **local**, **reverse** and **dynamic/SOCKS** forwarding) against live sshd
servers instead of mocks.

```
  this machine ──127.0.0.1:2201──▶  jump (172.28.0.11 / 172.29.0.11)
                                       sshd + echo on 127.0.0.1:7000
                                                    + echo on 0.0.0.0:7001
                                          │  (internal back network only)
                                          ▼
                                     dest (172.29.0.12)
                                       sshd + echo on 127.0.0.1:7000
                                                    + echo on 0.0.0.0:7001
```

- **jump** is on a host-reachable *front* network **and** an internal *back*
  network. Its sshd is published to `127.0.0.1:2201` on this machine.
- **dest** is on the internal *back* network **only** (`internal: true`), so it has
  no route to the host or the internet — it is reachable **solely from jump**.
- Each container runs **two echo services** (`socat … EXEC:cat` — send a line, it
  comes back after a one-line banner naming the container):
  - a **loopback** echo on `127.0.0.1:7000` — reachable only through an SSH forward
    (the target of the **local** tunnels, Scenarios A/B);
  - a **network-facing** echo on `0.0.0.0:7001` — reachable across the container
    network, so the sealed **dest** is reachable from **jump** at
    `172.29.0.12:7001`. This is what a **dynamic (SOCKS)** tunnel exiting at the
    jump reaches to prove it can hit a host sealed behind the bastion (Scenario C).

Everything is a **throwaway local test rig** — the credentials are intentionally
weak and must never be exposed.

## Make targets (run from the repo root)

| Target | What it does |
|--------|--------------|
| `make sandbox-create`  | Generate the SSH keypair, build the image, create the containers + networks (not started) |
| `make sandbox-start`   | Start the containers, then print access details |
| `make sandbox-stop`    | Stop the containers (fast restart; state kept) |
| `make sandbox-destroy` | Remove the containers + networks (keeps the image + keys) |
| `make sandbox-verify`  | Prove local (direct + via jump), dynamic (jump → sealed dest) and reverse (jump → host echo) forwarding all work |
| `make sandbox-host-echo` | Run the host-side echo the **reverse** tunnel forwards back to (leave running in its own terminal) |
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

`make sandbox-start` prints ready-to-enter tunnel definitions; `make sandbox-seed`
writes them straight into the `make debug` data dir. Host keys change on
destroy→recreate, so the first arm after a recreate raises Port Hippo's
trust-on-first-use prompt.

Four seeded tunnels, one per capability:

| Tunnel | Type | What it exercises |
|--------|------|-------------------|
| Sandbox — jump echo (direct)     | **local**   | `:18001` → jump's loopback echo |
| Sandbox — dest echo (via jump)   | **local**   | `:18002` → dest's echo through the jump chain |
| Sandbox — SOCKS proxy (via jump) | **dynamic** | SOCKS5 on `:18080`, exits at the jump |
| Sandbox — reverse forward (jump → host) | **remote** | binds `:9090` on the jump → an echo on this machine |

### Testing the dynamic (SOCKS) tunnel

Arm **Sandbox — SOCKS proxy (via jump)**, then point a SOCKS5 client at
`127.0.0.1:18080`. Because the proxy exits at the jump, it can reach the **sealed**
dest that nothing on the host can reach directly:

```
curl --socks5-hostname 127.0.0.1:18080 http://172.29.0.12:7001/
```

The echo mirrors raw bytes (not HTTP), so `curl` reports a protocol error — but the
connection succeeding proves the proxy tunnelled through to the sealed host. Point a
browser's SOCKS setting at the same port to browse "as if" from the jump.

### Testing the reverse (remote) tunnel

1. Run the local target in its own terminal: `make sandbox-host-echo` (binds
   `127.0.0.1:9091` on this machine).
2. Arm **Sandbox — reverse forward (jump → host)** in the debug app — it binds
   `127.0.0.1:9090` **on the jump** and forwards it back to your host echo.
3. Trigger it from inside the jump:

```
docker exec porthippo-jump sh -c 'echo ping | socat - TCP:127.0.0.1:9090'
```

You'll see the host echo's banner + `ping` come back, and the `make sandbox-host-echo`
terminal log the connection — proof the reverse forward carried it from the jump
back to this machine. (`make sandbox-verify` runs a self-contained version of this.)
