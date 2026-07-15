#!/usr/bin/env bash
# Print copy-paste-ready access details for the Port Hippo sandbox. Sourced values
# come from ./.env so this never drifts from docker-compose.yml.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
set -a; . "${DIR}/.env"; set +a

KEY="${DIR}/keys/id_porthippo"
bold() { printf '\033[1m%s\033[0m' "$1"; }
rule() { printf '  %s\n' "────────────────────────────────────────────────────────────────────"; }

cat <<EOF

  $(bold "Port Hippo sandbox — access details")
EOF
rule
cat <<EOF
  SSH login (works on BOTH containers):
      user:      ${SSH_USER}
      password:  ${SSH_PASSWORD}
      key:       ${KEY}   (+ .pub authorised on both)

  Static IPs:
      jump   front ${JUMP_FRONT_IP}   back ${JUMP_BACK_IP}   (host → 127.0.0.1:${JUMP_SSH_PORT})
      dest   back  ${DEST_BACK_IP}    (internal only — reachable ONLY via jump)

EOF
rule
cat <<EOF
  $(bold "Scenario A — tunnel straight to the JUMP host's echo")
  Port Hippo tunnel:
      Local port:        18001        (anything free on this machine)
      Destination host:  127.0.0.1    Destination port: ${ECHO_PORT}
      SSH server:        127.0.0.1    SSH port:         ${JUMP_SSH_PORT}
      Credential:        ${SSH_USER} + password OR key
  → arms an SSH session to the jump host and forwards to its loopback echo.

  $(bold "Scenario B — tunnel through JUMP to the DEST host's echo (jump chain)")
  Port Hippo tunnel:
      Local port:        18002
      Destination host:  127.0.0.1    Destination port: ${ECHO_PORT}
      SSH server:        ${DEST_BACK_IP}   SSH port: 22      (the FINAL hop = dest)
      Jump host:         127.0.0.1:${JUMP_SSH_PORT}  credential: ${SSH_USER}
      Credential:        ${SSH_USER} + password OR key   (dest uses the same login)
  → host → jump (${JUMP_SSH_PORT}) → dest (${DEST_BACK_IP}:22) → dest's loopback echo.

  $(bold "Scenario C — DYNAMIC (SOCKS5) proxy exiting at the JUMP host")
  Port Hippo tunnel (Forwarding type: Dynamic):
      SOCKS port:        ${SOCKS_LOCAL_PORT}       (local; point a browser/app here)
      Target server:     127.0.0.1:${JUMP_SSH_PORT}  (the SOCKS exit vantage = jump)
      Credential:        ${SSH_USER} + key
  → reaches ANY host the jump can, including the SEALED dest's network echo:
        curl --socks5-hostname 127.0.0.1:${SOCKS_LOCAL_PORT} http://${DEST_BACK_IP}:${NET_ECHO_PORT}/
    (the echo just mirrors bytes, so curl reports a protocol error — but the
     connection PROVES the proxy reached a host nothing on the host can reach.)

  $(bold "Scenario D — REMOTE (reverse) forward: JUMP port → an echo on THIS machine")
  Port Hippo tunnel (Forwarding type: Remote):
      Remote bind:       127.0.0.1:${REMOTE_BIND_PORT}  (bound ON the jump host)
      Local target:      127.0.0.1:${HOST_ECHO_PORT}    (an echo on this machine)
      Target server:     127.0.0.1:${JUMP_SSH_PORT}
      Credential:        ${SSH_USER} + key
  → 1) run the local target:   make sandbox-host-echo
     2) arm the tunnel, then trigger it from inside the jump:
        docker exec porthippo-jump sh -c \\
          'echo ping | socat - TCP:127.0.0.1:${REMOTE_BIND_PORT}'
     the jump's :${REMOTE_BIND_PORT} forwards back to your host echo on :${HOST_ECHO_PORT}.

EOF
rule
cat <<EOF
  Sanity-check WITHOUT Port Hippo (proves the topology; needs the generated key):

    # A) jump's echo, directly over ssh:
    ssh -i "${KEY}" -p ${JUMP_SSH_PORT} \\
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
        ${SSH_USER}@127.0.0.1 'echo ping | socat -t2 - TCP4:127.0.0.1:${ECHO_PORT}'

    # B) dest's echo, through the jump host. (ssh does NOT pass -o options to a
    #    -J jump hop, so carry them on the jump via an explicit ProxyCommand.)
    ssh -i "${KEY}" \\
        -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \\
        -o ProxyCommand="ssh -i ${KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -W %h:%p -p ${JUMP_SSH_PORT} ${SSH_USER}@127.0.0.1" \\
        ${SSH_USER}@${DEST_BACK_IP} 'echo ping | socat -t2 - TCP4:127.0.0.1:${ECHO_PORT}'

  Each prints the container's "[jump]/[dest] echo service ready" banner + "ping".
  (Or just run:  make sandbox-verify)

  Host keys are regenerated on destroy→create, so Port Hippo will show a
  trust-on-first-use prompt after each recreate — expected.

EOF
