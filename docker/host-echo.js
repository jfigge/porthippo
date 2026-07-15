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
 * host-echo.js — a tiny loopback TCP echo server that runs on THIS machine, the
 * local target a Feature 110 REMOTE (reverse, `ssh -R`) tunnel forwards back to.
 *
 * A remote tunnel binds a port on the jump container and forwards each inbound
 * connection back through SSH to a local address on the host. This is that local
 * address: bind `127.0.0.1:<port>`, print a one-line banner per connection (so you
 * can see WHICH echo you reached, matching the containers' socat echo), then echo
 * every byte back.
 *
 *   node docker/host-echo.js [port]         # default 9091 (HOST_ECHO_PORT)
 *   HOST_ECHO_PORT=9091 node docker/host-echo.js
 *
 * Leave it running (`make sandbox-host-echo`) while you exercise the reverse tunnel
 * from the jump container. Loopback-only — it never listens off-box.
 */
"use strict";

const net = require("node:net");

const port = Number(process.argv[2] || process.env.HOST_ECHO_PORT || 9091);
const HOST = "127.0.0.1";

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  socket.write("[host] echo service ready — anything you send comes back\n");
  socket.on("data", (chunk) => socket.write(chunk));
  socket.on("error", () => {});
  console.log(`[host-echo] connection from ${peer}`);
});

server.on("error", (err) => {
  console.error(`[host-echo] failed to bind ${HOST}:${port}: ${err.message}`);
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(
    `[host-echo] listening on ${HOST}:${port} — the reverse tunnel's local target. Ctrl-C to stop.`,
  );
});
