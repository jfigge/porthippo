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

function listen(server, host = "127.0.0.1", port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
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

async function startSsh({
  rejectForward = false,
  remoteForward = false,
  shell = false,
  port = 0,
} = {}) {
  const clients = new Set();
  const forwards = new Set(); // net.Servers bound for remote (tcpip-forward) forwards
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
      // Interactive-shell support (Feature 200 console sessions): accept a session
      // channel, its pty + window-change requests, and a shell request; the shell
      // is a simple echo — every byte written in is written back out — which lets a
      // test prove connect → input → output relay → resize → close end-to-end.
      if (shell) {
        client.on("session", (accept) => {
          const session = accept();
          session.on("pty", (a) => a && a());
          session.on("window-change", (a) => a && a());
          session.on("shell", (acceptShell) => {
            const stream = acceptShell();
            stream.on("data", (d) => {
              try {
                stream.write(d);
              } catch {
                // stream tearing down
              }
            });
            stream.on("error", () => {});
          });
        });
      }

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

      if (!remoteForward) return;
      // Remote (ssh -R) support: honour a tcpip-forward request by binding a real
      // local listener on the requested port; each inbound connection is pushed
      // back to the client as a forwarded-tcpip channel (fires its `tcp connection`).
      client.on("request", (accept, reject, name, info) => {
        if (name === "tcpip-forward") {
          const bindAddr = info.bindAddr || "127.0.0.1";
          let boundPort = info.bindPort;
          const fServer = net.createServer((sock) => {
            client.forwardOut(
              bindAddr,
              boundPort,
              sock.remoteAddress || "127.0.0.1",
              sock.remotePort || 0,
              (err, ch) => {
                if (err) {
                  sock.destroy();
                  return;
                }
                sock.pipe(ch);
                ch.pipe(sock);
                sock.on("error", () => {});
                ch.on("error", () => {});
              },
            );
          });
          fServer.on("error", () => {
            try {
              reject && reject();
            } catch {
              // already replied
            }
          });
          fServer.listen(info.bindPort, bindAddr, () => {
            boundPort = fServer.address().port;
            forwards.add(fServer);
            accept && accept(boundPort);
          });
        } else if (name === "cancel-tcpip-forward") {
          accept && accept();
        } else {
          reject && reject();
        }
      });
    });
  });
  const boundPort = await listen(server, "127.0.0.1", port);
  return {
    port: boundPort,
    total: () => total,
    active: () => clients.size,
    close: async () => {
      for (const f of forwards) {
        try {
          await closeServer(f);
        } catch {
          // already closed
        }
      }
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

// Read exactly `n` bytes from a socket (for driving the SOCKS handshake in tests).
function readBytes(sock, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        sock.off("data", onData);
        sock.off("error", onErr);
        resolve(buf.subarray(0, n));
        // Any surplus is pushed back so a following read/roundtrip still sees it.
        if (buf.length > n) sock.unshift(buf.subarray(n));
      }
    };
    const onErr = (e) => {
      sock.off("data", onData);
      reject(e);
    };
    sock.on("data", onData);
    sock.once("error", onErr);
  });
}

// Drive a SOCKS5 no-auth CONNECT to an IPv4 `host:port` over a local proxy socket.
// Resolves the connected socket (past the success reply) so a caller can roundtrip.
async function socks5Connect(proxyPort, host, port) {
  const sock = await connectLocal(proxyPort);
  sock.write(Buffer.from([0x05, 0x01, 0x00])); // greeting: one method, no-auth
  const methodReply = await readBytes(sock, 2);
  if (methodReply[0] !== 0x05 || methodReply[1] !== 0x00) {
    sock.destroy();
    throw new Error(`SOCKS method reply ${[...methodReply]}`);
  }
  const octets = host.split(".").map((n) => Number(n));
  const req = Buffer.from([
    0x05,
    0x01,
    0x00,
    0x01,
    ...octets,
    (port >> 8) & 0xff,
    port & 0xff,
  ]);
  sock.write(req);
  const reply = await readBytes(sock, 10); // IPv4 reply is 10 bytes
  return { sock, rep: reply[1] };
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
  autoReconnect = false,
  retry,
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
    autoReconnect,
    ...(retry ? { retry } : {}),
  };
}

/** A dynamic (SOCKS) engine def: a local SOCKS listener over the SSH chain. */
function makeDynamicDef({
  localPort,
  sshPort,
  jumps = [],
  keepAlive = false,
  enabled = true,
}) {
  return {
    id: `t${idSeq++}`,
    name: "socks tunnel",
    type: "dynamic",
    enabled,
    localPort,
    bindHost: "127.0.0.1",
    destination: null,
    sshServer: sshHop(sshPort),
    jumps,
    keepAlive,
    autoReconnect: false,
  };
}

/** A remote (reverse) engine def: bind `remotePort` on the server → local echo. */
function makeRemoteDef({
  remotePort,
  echoPort,
  sshPort,
  jumps = [],
  enabled = true,
}) {
  return {
    id: `t${idSeq++}`,
    name: "remote tunnel",
    type: "remote",
    enabled,
    remoteBind: { host: "127.0.0.1", port: remotePort },
    destination: { host: "127.0.0.1", port: echoPort },
    sshServer: sshHop(sshPort),
    jumps,
    keepAlive: false,
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

function fakeStores(defs, { defaultLingerMs = 10000, settings = {} } = {}) {
  const byId = new Map(defs.map((d) => [d.id, d]));
  return {
    tunnelStore: () => ({
      listDecrypted: () => [...byId.values()],
      getDecrypted: (id) => byId.get(id) || null,
    }),
    knownHostsStore: () => ({ get: () => null, trust: () => {} }),
    // Feature 130 tests seed the reconnect policy / keepalive here (they layer
    // over defaultLingerMs, so existing callers are unchanged).
    settingsStore: () => ({ get: () => ({ defaultLingerMs, ...settings }) }),
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
  readBytes,
  socks5Connect,
  sshHop,
  makeDef,
  makeDynamicDef,
  makeRemoteDef,
  trustAll,
  makeTunnel,
  gatedVerifier,
  fakeStores,
};
