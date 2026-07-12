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
 * tests/harness.js — the shared in-process test rig for the SSH tunnel engine.
 *
 * It stands up a real `ssh2` server (password auth, implementing `direct-tcpip`
 * forwarding) and a plain TCP echo server as the destination, plus the small async
 * helpers used to drive a genuine local socket through a tunnel end-to-end. The
 * Feature 20 (`tunnel-engine.test.js`) and Feature 30 (`pause-resume.test.js`)
 * suites both build on this so the harness lives in one place.
 *
 * Not a test file itself (no `*.test.js` suffix), so `node --test` imports it but
 * never executes it as a suite.
 */
"use strict";

const net = require("net");
const crypto = require("crypto");
const { Server } = require("ssh2");

const { Tunnel } = require("../tunnel");

// One host key for every in-process ssh server (RSA PEM — parseable by ssh2).
// Generated once here so both suites share the (relatively expensive) keygen.
const { privateKey: HOST_KEY } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
});

// ── Small async helpers ─────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await delay(interval);
  }
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await closeServer(s);
  return port;
}

function connectLocal(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => resolve(sock));
    sock.once("error", reject);
  });
}

// Retry a local connect across the brief re-bind gap during a reconcile re-arm.
async function connectLocalRetry(port, { retries = 40, gap = 25 } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await connectLocal(port);
    } catch (err) {
      if (i >= retries) throw err;
      await delay(gap);
    }
  }
}

function roundtrip(sock, msg) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      if (buf.length >= msg.length) {
        sock.off("data", onData);
        resolve(buf);
      }
    };
    sock.on("data", onData);
    sock.once("error", reject);
    sock.write(msg);
  });
}

// ── In-process servers ──────────────────────────────────────────────────────────

async function startEcho({ transform } = {}) {
  const server = net.createServer((s) => {
    s.on("data", (d) => s.write(transform ? transform(d) : d));
    s.on("error", () => {});
  });
  const port = await listen(server);
  return { port, close: () => closeServer(server) };
}

async function startSsh({ rejectForward = false } = {}) {
  const clients = new Set();
  let total = 0;
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    total += 1;
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (
        ctx.method === "password" &&
        ctx.username === "me" &&
        ctx.password === "secret"
      ) {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        if (rejectForward) {
          // Refuse the direct-tcpip channel so the client's forwardOut rejects —
          // the harness stand-in for a destination that's refused/unreachable.
          reject();
          return;
        }
        const ch = accept();
        const conn = net.connect(info.destPort, info.destIP, () => {
          ch.pipe(conn);
          conn.pipe(ch);
        });
        conn.on("error", () => {
          try {
            reject();
          } catch {
            // channel already gone
          }
        });
        ch.on("error", () => {});
      });
    });
  });
  const port = await listen(server);
  return {
    port,
    total: () => total,
    active: () => clients.size,
    close: async () => {
      for (const c of clients) {
        try {
          c.end();
        } catch {
          // already closing
        }
      }
      await closeServer(server);
    },
  };
}

// ── Definition + tunnel builders ────────────────────────────────────────────────

let idSeq = 0;

function sshHop(port) {
  return {
    host: "127.0.0.1",
    port,
    user: "me",
    auth: [{ type: "password", password: "secret" }],
  };
}

function makeDef({
  localPort,
  echoPort,
  sshPort,
  jumps = [],
  keepAlive = false,
  enabled = true,
}) {
  return {
    id: `t${idSeq++}`,
    name: "test tunnel",
    enabled,
    localPort,
    bindHost: "127.0.0.1",
    destination: { host: "127.0.0.1", port: echoPort },
    sshServer: sshHop(sshPort),
    jumps,
    keepAlive,
    autoReconnect: false,
  };
}

const trustAll = () => (_key, verify) => verify(true);

function makeTunnel(
  def,
  {
    lingerMs = 60,
    hostVerifierFactory = trustAll,
    baseBackoffMs,
    maxBackoffMs,
    maxReconnectAttempts,
  } = {},
) {
  const states = [];
  const tunnel = new Tunnel(def, {
    hostVerifierFactory,
    getLingerMs: () => lingerMs,
    onStateChange: (s) => states.push(s.state),
    baseBackoffMs,
    maxBackoffMs,
    maxReconnectAttempts,
  });
  return { tunnel, states };
}

/**
 * A host-verifier factory that holds every handshake pending at host
 * verification until `release()` is called (then accepts). Lets a test freeze a
 * tunnel in `connecting` and drive teardown races deterministically.
 */
function gatedVerifier() {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const factory = () => (_key, verify) => {
    gate.then(() => verify(true));
  };
  return { factory, release: () => release() };
}

function fakeStores(defs, { defaultLingerMs = 10000 } = {}) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    tunnelStore: () => ({
      listDecrypted: () => [...byId.values()],
      getDecrypted: (id) => byId.get(id) || null,
    }),
    knownHostsStore: () => ({ get: () => null, trust: () => {} }),
    settingsStore: () => ({ get: () => ({ defaultLingerMs }) }),
  };
}

module.exports = {
  HOST_KEY,
  delay,
  waitFor,
  listen,
  closeServer,
  freePort,
  connectLocal,
  connectLocalRetry,
  roundtrip,
  startEcho,
  startSsh,
  sshHop,
  makeDef,
  trustAll,
  makeTunnel,
  gatedVerifier,
  fakeStores,
};
