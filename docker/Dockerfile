# Port Hippo — integration-test sandbox image.
#
# One image, used by BOTH the jump host and the destination (behaviour is set by
# env vars at runtime). It runs:
#   * an OpenSSH server accepting BOTH password and public-key auth, and
#   * a loopback-only echo service (socat) on 127.0.0.1:${ECHO_PORT} — reachable
#     only from inside the container, i.e. only through an SSH forward.
FROM alpine:3.20

# openssh — the SSH server + ssh-keygen; socat — the tiny echo service.
RUN apk add --no-cache openssh socat

# The unprivileged login used for the tunnels. Password is set at runtime
# (entrypoint, from $SSH_PASSWORD); the public key is mounted at /keys.
ARG SSH_USER=tunnel
RUN adduser -D -s /bin/sh "${SSH_USER}" \
    && mkdir -p /var/empty

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY echo-service.sh /usr/local/bin/echo-service.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/echo-service.sh

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
