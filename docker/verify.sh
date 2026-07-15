#!/usr/bin/env bash
# Prove the sandbox topology end-to-end WITHOUT Port Hippo: reach the jump host's
# echo directly, then the dest host's echo through the jump (ProxyJump). Exits
# non-zero if either hop fails. Requires the containers to be running + the key.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
set -a; . "${DIR}/.env"; set +a
KEY="${DIR}/keys/id_porthippo"

# Host-key checks are disabled because host keys change on every recreate; this is
# a throwaway local rig. NB: these options must be repeated for the jump hop too —
# ssh does NOT propagate them to a `-J`/ProxyJump connection — so hop B builds an
# explicit ProxyCommand that carries them on BOTH hops.
NOHK=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
      -o ConnectTimeout=5 -o LogLevel=ERROR)
SSH_OPTS=(-i "${KEY}" "${NOHK[@]}")
ECHO_CMD="echo ping | socat -t2 - TCP4:127.0.0.1:${ECHO_PORT}"

fail() { printf '   \033[31m✖ %s\033[0m\n' "$1"; exit 1; }
ok()   { printf '   \033[32m✔ %s\033[0m\n' "$1"; }

echo "A) jump echo (direct SSH to 127.0.0.1:${JUMP_SSH_PORT})..."
out="$(ssh "${SSH_OPTS[@]}" -p "${JUMP_SSH_PORT}" "${SSH_USER}@127.0.0.1" "${ECHO_CMD}" 2>/dev/null || true)"
echo "${out}" | grep -q ping && ok "jump echo OK" || fail "jump echo FAILED"

echo "B) dest echo (through the jump host to ${DEST_BACK_IP})..."
PROXY="ssh -i ${KEY} ${NOHK[*]} -W %h:%p -p ${JUMP_SSH_PORT} ${SSH_USER}@127.0.0.1"
out="$(ssh "${SSH_OPTS[@]}" -o ProxyCommand="${PROXY}" \
        "${SSH_USER}@${DEST_BACK_IP}" "${ECHO_CMD}" 2>/dev/null || true)"
echo "${out}" | grep -q ping && ok "dest echo OK (jump chain)" || fail "dest echo FAILED"

# Hops A/B use KEY auth. Also confirm PASSWORD auth is accepted, when a tool to
# script the prompt is present (sshpass or expect); skip gracefully otherwise.
echo "C) password auth (jump host)..."
PW_OPTS=(-o PreferredAuthentications=password -o PubkeyAuthentication=no -p "${JUMP_SSH_PORT}")
if command -v sshpass >/dev/null 2>&1; then
  out="$(sshpass -p "${SSH_PASSWORD}" ssh "${NOHK[@]}" "${PW_OPTS[@]}" \
          "${SSH_USER}@127.0.0.1" "${ECHO_CMD}" 2>/dev/null || true)"
  echo "${out}" | grep -q ping && ok "password auth OK" || fail "password auth FAILED"
elif command -v expect >/dev/null 2>&1; then
  out="$(expect -c "
    set timeout 12
    spawn ssh ${NOHK[*]} ${PW_OPTS[*]} ${SSH_USER}@127.0.0.1 {${ECHO_CMD}}
    expect { -re {[Pp]assword:} { send \"${SSH_PASSWORD}\r\"; exp_continue } eof }
  " 2>/dev/null || true)"
  echo "${out}" | grep -q ping && ok "password auth OK" || fail "password auth FAILED"
else
  printf '   \033[33m— skipped (install sshpass or expect to test password auth)\033[0m\n'
fi

# ── Feature 110: the two new forwarding types ────────────────────────────────
# D) DYNAMIC (SOCKS) reachability: a dynamic tunnel exits at the jump host, so its
# reach is "whatever the jump can reach". Prove that includes the SEALED dest, via
# the dest's NETWORK echo (0.0.0.0:${NET_ECHO_PORT}) — exactly what a SOCKS CONNECT
# to ${DEST_BACK_IP}:${NET_ECHO_PORT} from the proxy would do.
echo "D) dynamic reach (jump → sealed dest's network echo ${DEST_BACK_IP}:${NET_ECHO_PORT})..."
NET_CMD="echo ping | socat -t2 - TCP4:${DEST_BACK_IP}:${NET_ECHO_PORT}"
out="$(ssh "${SSH_OPTS[@]}" -p "${JUMP_SSH_PORT}" "${SSH_USER}@127.0.0.1" "${NET_CMD}" 2>/dev/null || true)"
echo "${out}" | grep -q ping && ok "dynamic reach OK (jump → sealed dest)" || fail "dynamic reach FAILED"

# E) REMOTE (reverse) forwarding: bind a port ON the jump and forward it back to a
# host-side echo, then trigger it from the jump — a self-contained `ssh -R` mirror
# of Port Hippo's remote tunnel. Uses this repo's node host-echo.js as the target.
echo "E) reverse forward (jump binds :${REMOTE_BIND_PORT} → host echo :${HOST_ECHO_PORT})..."
node "${DIR}/host-echo.js" "${HOST_ECHO_PORT}" >/dev/null 2>&1 &
HOST_ECHO_PID=$!
cleanup() { kill "${HOST_ECHO_PID}" 2>/dev/null || true; }
trap cleanup EXIT
sleep 0.5
REV_CMD="echo ping | socat -t2 - TCP4:127.0.0.1:${REMOTE_BIND_PORT}"
out="$(ssh "${SSH_OPTS[@]}" -R "127.0.0.1:${REMOTE_BIND_PORT}:127.0.0.1:${HOST_ECHO_PORT}" \
        -p "${JUMP_SSH_PORT}" "${SSH_USER}@127.0.0.1" "${REV_CMD}" 2>/dev/null || true)"
echo "${out}" | grep -q ping && ok "reverse forward OK (jump → host echo)" || fail "reverse forward FAILED"
cleanup; trap - EXIT

printf '\n   \033[32mSandbox verified: local, dynamic (SOCKS) and reverse forwarding all work.\033[0m\n\n'
