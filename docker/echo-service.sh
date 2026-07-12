#!/bin/sh
# Per-connection echo handler (run by socat). Prints a one-line banner so a human
# poking at the tunnel can tell WHICH container they reached, then echoes every
# subsequent byte straight back (Port Hippo's relay tests use the same send-X /
# get-X shape).
printf '[%s] echo service ready — anything you send comes back\n' "${ECHO_NAME:-echo}"
exec cat
