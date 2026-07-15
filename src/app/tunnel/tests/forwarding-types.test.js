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

// forwarding-types.test.js — Feature 110 end-to-end coverage for the two new
// forwarding types over the shared in-process harness: `dynamic` (a local SOCKS5
// proxy) and `remote` (a reverse forward bound on the SSH server). Local forwarding
// is covered by tunnel-engine.test.js; here we prove the SOCKS handshake + relay
// and the reverse `forwardIn` + relay carry real bytes and honour the lifecycle.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  waitFor,
  freePort,
  connectLocalRetry,
  roundtrip,
  startEcho,
  startSsh,
  socks5Connect,
  makeDynamicDef,
  makeRemoteDef,
  makeTunnel,
} = require("./harness");

// ── dynamic (SOCKS5) ─────────────────────────────────────────────────────────

test("a dynamic tunnel proxies a SOCKS5 CONNECT through the chain", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const def = makeDynamicDef({ localPort, sshPort: ssh.port });
  const { tunnel } = makeTunnel(def, { lingerMs: 60 });

  await tunnel.arm();
  assert.equal(tunnel.state, "listening", "SOCKS listener binds, SSH is lazy");

  // A SOCKS client asks the proxy to reach the echo server; the reply is success
  // (0x00) and the tunnel forwarded the CONNECT through the SSH chain.
  const { sock, rep } = await socks5Connect(localPort, "127.0.0.1", echo.port);
  assert.equal(rep, 0x00, "SOCKS CONNECT succeeded");
  assert.equal(await roundtrip(sock, "hello socks"), "hello socks");
  await waitFor(() => ssh.active() >= 1);

  // Closing the only SOCKS connection idles the tunnel → SSH tears down after
  // linger while the SOCKS listener stays bound (dynamic lingers like local).
  sock.destroy();
  await waitFor(() => ssh.active() === 0);
  assert.equal(tunnel.state, "listening");

  await tunnel.disarm();
  await ssh.close();
  await echo.close();
});

test("a dynamic tunnel counts bytes + connections in its stats", async () => {
  const echo = await startEcho();
  const ssh = await startSsh();
  const localPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDynamicDef({ localPort, sshPort: ssh.port }),
    { lingerMs: 60 },
  );

  await tunnel.arm();
  const { sock } = await socks5Connect(localPort, "127.0.0.1", echo.port);
  await roundtrip(sock, "measured");
  await waitFor(() => tunnel.statsSnapshot().bytesDown > 0);

  const snap = tunnel.statsSnapshot();
  assert.ok(
    snap.bytesUp > 0 && snap.bytesDown > 0,
    "traffic counted both ways",
  );
  assert.ok(snap.connectionCount >= 1, "the SOCKS connection was counted");

  sock.destroy();
  await tunnel.disarm();
  await ssh.close();
  await echo.close();
});

test("a dynamic SOCKS request to a refused destination replies with a failure", async () => {
  const ssh = await startSsh({ rejectForward: true }); // every forwardOut is refused
  const localPort = await freePort();
  const deadPort = await freePort();
  const { tunnel } = makeTunnel(
    makeDynamicDef({ localPort, sshPort: ssh.port }),
    { lingerMs: 60 },
  );

  await tunnel.arm();
  const { rep } = await socks5Connect(localPort, "127.0.0.1", deadPort);
  assert.notEqual(rep, 0x00, "the client gets a non-success SOCKS reply");

  await tunnel.disarm();
  await ssh.close();
});

// ── remote (reverse) ─────────────────────────────────────────────────────────

test("a remote tunnel binds a server port and relays back to a local target", async () => {
  const echo = await startEcho(); // the LOCAL target the remote port forwards to
  const ssh = await startSsh({ remoteForward: true });
  const remotePort = await freePort();
  const def = makeRemoteDef({
    remotePort,
    echoPort: echo.port,
    sshPort: ssh.port,
  });
  const { tunnel } = makeTunnel(def);

  // Remote connects eagerly on arm (no local listener) and holds the SSH open.
  await tunnel.arm();
  await waitFor(() => tunnel.state === "connected");
  await waitFor(() => ssh.active() >= 1);

  // Connect to the port the server bound; bytes travel back through the reverse
  // forward to the local echo target. Retry across the forwardIn bind window.
  const sock = await connectLocalRetry(remotePort);
  assert.equal(await roundtrip(sock, "reverse!"), "reverse!");
  await waitFor(() => tunnel.status().connections >= 1);

  sock.destroy();
  await tunnel.disarm();
  assert.equal(tunnel.state, "disarmed");
  await waitFor(() => ssh.active() === 0);
  await ssh.close();
  await echo.close();
});

test("a remote tunnel holds the SSH connection open with no inbound traffic", async () => {
  const echo = await startEcho();
  const ssh = await startSsh({ remoteForward: true });
  const remotePort = await freePort();
  const { tunnel } = makeTunnel(
    makeRemoteDef({ remotePort, echoPort: echo.port, sshPort: ssh.port }),
    { lingerMs: 30 },
  );

  await tunnel.arm();
  await waitFor(() => tunnel.state === "connected");
  // Well past the linger window, with zero inbound connections, it stays connected
  // (remote holds open like keepAlive — there is no local access to re-trigger it).
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(tunnel.state, "connected");
  assert.ok(ssh.active() >= 1, "SSH connection still up");

  await tunnel.disarm();
  await ssh.close();
  await echo.close();
});
