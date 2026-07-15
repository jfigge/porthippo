/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * e2e.js — end-to-end exercise of every Port Hippo forwarding type against the
 * Docker sandbox, driving the REAL tunnel engine (src/app/tunnel), not raw ssh.
 *
 * Where `verify.sh` proves the sandbox topology with the system `ssh` binary, this
 * proves Port Hippo's OWN listener → ssh-chain → relay / socks5 code carries real
 * bytes over that topology. It mirrors the four seeded sandbox definitions (see
 * docker/seed-porthippo.js), one per scenario:
 *
 *   A) local  (direct)   — SSH to the jump, forward to its loopback echo.
 *   B) local  (via jump) — SSH to the sealed dest THROUGH the jump, forward to
 *                          the dest's loopback echo (password hop + key hop).
 *   C) dynamic (SOCKS)   — a local SOCKS5 proxy exiting at the jump; CONNECT to
 *                          the sealed dest's network echo (proves jump-vantage reach).
 *   D) remote (reverse)  — bind a port ON the jump and forward inbound back to a
 *                          host-side echo; trigger it from inside the jump container.
 *
 * Host-key verification is trust-all here (the sandbox regenerates host keys on
 * recreate — this is a throwaway local rig, exactly like verify.sh's
 * StrictHostKeyChecking=no). It never touches your real known-hosts store.
 *
 * Reuses the engine's own in-process test harness for the Tunnel builder and the
 * traffic drivers, so this driver stays in lockstep with how the unit tests call
 * the engine.
 *
 *   node docker/e2e.js          # requires the sandbox running (make sandbox-start)
 *
 * Exits 0 iff every scenario round-trips; non-zero (with a summary) otherwise, so
 * it is safe to wire into `make sandbox-e2e` / CI.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileP = promisify(execFile);

const DOCKER = __dirname;
const { makeTunnel, connectLocal, socks5Connect, waitFor, freePort } = require(
  path.join(DOCKER, "..", "src", "app", "tunnel", "tests", "harness"),
);

// ── Config (read from docker/.env so it never drifts from the compose file) ──────
function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

const env = readEnv(path.join(DOCKER, ".env"));
const SSH_USER = env.SSH_USER || "tunnel";
const SSH_PASSWORD = env.SSH_PASSWORD || "tunnelpass";
const JUMP_SSH_PORT = Number(env.JUMP_SSH_PORT || 2201);
const DEST_BACK_IP = env.DEST_BACK_IP || "172.29.0.12";
const ECHO_PORT = Number(env.ECHO_PORT || 7000);
const NET_ECHO_PORT = Number(env.NET_ECHO_PORT || 7001);
const KEY_PATH = path.join(DOCKER, "keys", "id_porthippo");
const JUMP_CONTAINER = "porthippo-jump";

// The reverse scenario binds its own dedicated port ON the jump (distinct from the
// seed's REMOTE_BIND_PORT) so this test can run even while the debug app has the
// seeded "reverse forward" tunnel armed on 9090.
const E2E_REMOTE_BIND_PORT = Number(env.REMOTE_BIND_PORT || 9090) + 100; // 9190

// ── Tiny terminal colours (match verify.sh) ──────────────────────────────────────
const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ── SSH hop builders (engine-shaped, pointed at the sandbox) ──────────────────────
const keyHop = (host, port) => ({
  host,
  port,
  user: SSH_USER,
  auth: [{ type: "key", privateKeyPath: KEY_PATH }],
});
const pwHop = (host, port) => ({
  host,
  port,
  user: SSH_USER,
  auth: [{ type: "password", password: SSH_PASSWORD }],
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// The sandbox echo prints a one-line banner on connect, then echoes bytes. So we
// send a unique token and resolve once it comes back — tolerating the banner (and
// any framing) rather than assuming the first bytes are our echo.
function expectToken(sock, token, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (fn, arg) => {
      clearTimeout(timer);
      sock.off("data", onData);
      sock.off("error", onErr);
      fn(arg);
    };
    const onData = (d) => {
      buf += d.toString("utf8");
      if (buf.includes(token)) done(resolve, buf);
    };
    const onErr = (e) => done(reject, e);
    const timer = setTimeout(
      () =>
        done(
          reject,
          new Error(`timed out; got ${JSON.stringify(buf.slice(0, 160))}`),
        ),
      timeout,
    );
    sock.on("data", onData);
    sock.once("error", onErr);
    sock.write(token + "\n");
  });
}

// A fixed-port loopback echo — the local target the reverse tunnel forwards back to.
function startEchoOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((s) => {
      s.on("data", (d) => s.write(d));
      s.on("error", () => {});
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

// Trigger the reverse forward from INSIDE the jump container (the bound port lives
// on the jump's loopback, unreachable from the host). Mirrors `verify.sh`'s socat.
//
// MUST run async: a blocking exec (execFileSync) would freeze this process's event
// loop while socat is connected, starving ssh2 of the cycles it needs to service
// the inbound forwarded channel — so the reverse forward would appear to hang. The
// `sleep` holds the connection open long enough for the round-trip to complete
// before EOF, mirroring how the local/dynamic scenarios read before closing.
async function triggerReverse(jumpBindPort, token) {
  const cmd = `(printf '%s\\n' '${token}'; sleep 1) | socat -t3 - TCP4:127.0.0.1:${jumpBindPort}`;
  const { stdout } = await execFileP(
    "docker",
    ["exec", JUMP_CONTAINER, "sh", "-c", cmd],
    { encoding: "utf8", timeout: 12000 },
  );
  return stdout;
}

async function retry(fn, { tries = 6, gap = 500 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, gap));
    }
  }
  throw last;
}

const TUNNEL_OPTS = { lingerMs: 5000 };

// ── Scenarios ─────────────────────────────────────────────────────────────────
// Each returns nothing on success and throws on failure. All cleanup happens in a
// finally so one scenario never leaks a bound listener / SSH connection into the next.

async function scenarioLocalDirect() {
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    {
      id: "e2e-local-direct",
      name: "e2e local (direct)",
      type: "local",
      enabled: true,
      localPort,
      bindHost: "127.0.0.1",
      destination: { host: "127.0.0.1", port: ECHO_PORT },
      sshServer: keyHop("127.0.0.1", JUMP_SSH_PORT),
      jumps: [],
      keepAlive: false,
      autoReconnect: false,
    },
    TUNNEL_OPTS,
  );
  try {
    await tunnel.arm();
    const sock = await connectLocal(localPort);
    const token = `PH-E2E-A-${process.pid}`;
    await expectToken(sock, token);
    sock.destroy();
  } finally {
    await tunnel.disarm();
  }
}

async function scenarioLocalViaJump() {
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    {
      id: "e2e-local-jump",
      name: "e2e local (via jump)",
      type: "local",
      enabled: true,
      localPort,
      bindHost: "127.0.0.1",
      destination: { host: "127.0.0.1", port: ECHO_PORT },
      sshServer: keyHop(DEST_BACK_IP, 22), // final SSH server = sealed dest
      jumps: [pwHop("127.0.0.1", JUMP_SSH_PORT)], // reached through the jump (password hop)
      keepAlive: false,
      autoReconnect: false,
    },
    TUNNEL_OPTS,
  );
  try {
    await tunnel.arm();
    const sock = await connectLocal(localPort);
    const token = `PH-E2E-B-${process.pid}`;
    await expectToken(sock, token);
    sock.destroy();
  } finally {
    await tunnel.disarm();
  }
}

async function scenarioDynamicSocks() {
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    {
      id: "e2e-dynamic",
      name: "e2e dynamic (SOCKS)",
      type: "dynamic",
      enabled: true,
      localPort,
      bindHost: "127.0.0.1",
      destination: null,
      sshServer: keyHop("127.0.0.1", JUMP_SSH_PORT), // SOCKS exit = the jump
      jumps: [],
      keepAlive: false,
      autoReconnect: false,
    },
    TUNNEL_OPTS,
  );
  try {
    await tunnel.arm();
    // CONNECT to the SEALED dest's network echo — reachable only from the jump.
    const { sock, rep } = await socks5Connect(
      localPort,
      DEST_BACK_IP,
      NET_ECHO_PORT,
    );
    if (rep !== 0x00)
      throw new Error(`SOCKS CONNECT failed (reply 0x${rep.toString(16)})`);
    const token = `PH-E2E-C-${process.pid}`;
    await expectToken(sock, token);
    sock.destroy();
  } finally {
    await tunnel.disarm();
  }
}

async function scenarioRemoteReverse() {
  const hostEchoPort = await freePort(); // host-side target the reverse forward reaches
  const echo = await startEchoOn(hostEchoPort);
  const { tunnel } = makeTunnel(
    {
      id: "e2e-remote",
      name: "e2e remote (reverse)",
      type: "remote",
      enabled: true,
      remoteBind: { host: "127.0.0.1", port: E2E_REMOTE_BIND_PORT }, // bound on the jump
      destination: { host: "127.0.0.1", port: hostEchoPort }, // the host-side echo
      sshServer: keyHop("127.0.0.1", JUMP_SSH_PORT),
      jumps: [],
      keepAlive: false,
      autoReconnect: false,
    },
    TUNNEL_OPTS,
  );
  try {
    await tunnel.arm();
    await waitFor(() => tunnel.state === "connected", { timeout: 10000 });
    const token = `PH-E2E-D-${process.pid}`;
    // The forwardIn bind can lag the 'connected' state a touch — retry the whole
    // round-trip (trigger + assertion) so a too-early first attempt just re-runs.
    await retry(async () => {
      const out = await triggerReverse(E2E_REMOTE_BIND_PORT, token);
      if (!out.includes(token)) {
        throw new Error(
          `reverse echo missing token; got ${JSON.stringify(out.slice(0, 160))}`,
        );
      }
    });
  } finally {
    await tunnel.disarm();
    await echo.close();
  }
}

const SCENARIOS = [
  ["A", "local  (direct)      ", scenarioLocalDirect],
  ["B", "local  (via jump)    ", scenarioLocalViaJump],
  ["C", "dynamic (SOCKS)      ", scenarioDynamicSocks],
  ["D", "remote (reverse)     ", scenarioRemoteReverse],
];

// ── Preflight + run ─────────────────────────────────────────────────────────────
function tcpReachable(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

async function preflight() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error(
      c.bad(`✖ sandbox key missing: ${KEY_PATH}`) +
        "\n  Run 'make sandbox-create' first.",
    );
    process.exit(2);
  }
  if (!(await tcpReachable("127.0.0.1", JUMP_SSH_PORT))) {
    console.error(
      c.bad(`✖ jump host not reachable on 127.0.0.1:${JUMP_SSH_PORT}`) +
        "\n  The sandbox isn't running. Start it with 'make sandbox-start'.",
    );
    process.exit(2);
  }
}

async function main() {
  await preflight();
  console.log(
    `\nPort Hippo e2e — driving the real tunnel engine over the Docker sandbox\n` +
      c.dim(
        `  jump=127.0.0.1:${JUMP_SSH_PORT}  dest=${DEST_BACK_IP}  user=${SSH_USER}\n`,
      ),
  );

  let failures = 0;
  for (const [id, label, run] of SCENARIOS) {
    const started = process.hrtime.bigint();
    try {
      await run();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      console.log(
        `  ${c.ok("✔")} ${id}) ${label} ${c.dim(`(${ms.toFixed(0)} ms)`)}`,
      );
    } catch (err) {
      failures++;
      console.log(
        `  ${c.bad("✖")} ${id}) ${label} ${c.bad((err && err.message) || err)}`,
      );
    }
  }

  console.log();
  if (failures === 0) {
    console.log(
      c.ok(
        `  All ${SCENARIOS.length} tunnel types round-tripped through Port Hippo. ✔\n`,
      ),
    );
    process.exit(0);
  }
  console.error(
    c.bad(`  ${failures}/${SCENARIOS.length} scenario(s) FAILED.\n`),
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(c.bad(`e2e crashed: ${(err && err.stack) || err}`));
  process.exit(1);
});
