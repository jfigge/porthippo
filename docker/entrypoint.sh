#!/bin/sh
# Container entrypoint: apply the runtime credentials, start the loopback echo
# service, then run sshd in the foreground (PID 1).
set -eu

SSH_USER="${SSH_USER:-tunnel}"
SSH_PASSWORD="${SSH_PASSWORD:-tunnelpass}"
ECHO_NAME="${ECHO_NAME:-echo}"
ECHO_PORT="${ECHO_PORT:-7000}"

# ── Password auth ────────────────────────────────────────────────────────────
# adduser -D leaves the account locked; setting a password unlocks it.
echo "${SSH_USER}:${SSH_PASSWORD}" | chpasswd

# ── Public-key auth ──────────────────────────────────────────────────────────
# The keypair is generated on the host at `make sandbox-create` and mounted here
# read-only; install the PUBLIC half into the user's authorized_keys.
if [ -f /keys/authorized_keys ]; then
  install -d -m 700 -o "${SSH_USER}" -g "${SSH_USER}" "/home/${SSH_USER}/.ssh"
  install -m 600 -o "${SSH_USER}" -g "${SSH_USER}" \
    /keys/authorized_keys "/home/${SSH_USER}/.ssh/authorized_keys"
else
  echo "[entrypoint] WARNING: /keys/authorized_keys not mounted — key auth disabled" >&2
fi

# ── Host keys ────────────────────────────────────────────────────────────────
# Created on first boot and then persisted in the container FS, so they are
# STABLE across stop/start but CHANGE on destroy/recreate (which is handy for
# exercising Port Hippo's trust-on-first-use and changed-key flows).
ssh-keygen -A

# ── Loopback-only echo service ───────────────────────────────────────────────
# Bound to 127.0.0.1 inside the container, so it is reachable ONLY via an SSH
# forward — never directly from the network or the host.
ECHO_NAME="${ECHO_NAME}" socat \
  "TCP4-LISTEN:${ECHO_PORT},bind=127.0.0.1,reuseaddr,fork" \
  EXEC:/usr/local/bin/echo-service.sh &

echo "[entrypoint] ${ECHO_NAME}: sshd on :22, echo on 127.0.0.1:${ECHO_PORT}, user '${SSH_USER}'"

# sshd in the foreground keeps the container alive; -e logs to stderr (→ docker logs).
exec /usr/sbin/sshd -D -e
