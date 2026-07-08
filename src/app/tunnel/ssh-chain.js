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
 * ssh-chain.js — establish an SSH connection to the tunnel-terminating server,
 * chaining through zero or more jump hosts.
 *
 * Each hop is an `ssh2.Client`. The first hop connects over a plain TCP socket;
 * every later hop connects over a `direct-tcpip` stream forwarded from the previous
 * hop (`forwardOut`), passed as ssh2's `sock` option. That is standard SSH
 * jump-host chaining done in-process, so we never shell out to `ssh -J`.
 *
 * Each hop authenticates independently: its `auth[]` methods are tried in order via
 * ssh2's `authHandler` array (agent / private key / password). A method with no
 * usable secret (missing key file, a secret that failed to decrypt) is skipped, not
 * fatal. Host-key verification is applied per hop through the injected verifier
 * factory — an unknown key holds the whole chain pending until the user decides.
 *
 * `connectChain()` resolves `{ client, dispose }` where `client` is the final,
 * ready hop (the one that reaches the destination) and `dispose()` ends every hop.
 */
"use strict";

const fs = require("fs");
const { Client } = require("ssh2");

/** Resolve the SSH agent endpoint for `agent` auth, or null when unavailable. */
function resolveAgent() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK;
  // Windows: fall back to Pageant / the OpenSSH agent named pipe.
  if (process.platform === "win32") return "pageant";
  return null;
}

/**
 * Build ssh2's `authHandler` array for a hop from its (decrypted) auth list, in
 * order. Entries that can't be satisfied are dropped so ssh2 moves on cleanly.
 * @param {object} hop  decrypted hop: { host, port, user, auth: [...] }
 * @param {typeof fs.readFileSync} [readFileSync]  injectable for tests
 * @returns {Array<object>}
 */
function buildAuthHandler(hop, readFileSync = fs.readFileSync) {
  const username = hop.user;
  const handlers = [];
  for (const entry of Array.isArray(hop.auth) ? hop.auth : []) {
    if (!entry || typeof entry !== "object") continue;
    // A secret that could not be decrypted is flagged and treated as absent.
    if (entry.decryptError) continue;

    if (entry.type === "agent") {
      const agent = resolveAgent();
      if (agent) handlers.push({ type: "agent", username, agent });
    } else if (entry.type === "key") {
      if (!entry.privateKeyPath) continue;
      let key;
      try {
        key = readFileSync(entry.privateKeyPath);
      } catch {
        continue; // unreadable key file → skip this method
      }
      const handler = { type: "publickey", username, key };
      if (typeof entry.passphrase === "string" && entry.passphrase.length > 0) {
        handler.passphrase = entry.passphrase;
      }
      handlers.push(handler);
    } else if (entry.type === "password") {
      if (typeof entry.password === "string" && entry.password.length > 0) {
        handlers.push({ type: "password", username, password: entry.password });
      }
    }
  }
  return handlers;
}

/** Wrap a hop failure with which hop failed, without leaking any secret. */
function hopError(err, hop, hopLabel) {
  const out = new Error(
    `SSH ${hopLabel} (${hop.host}:${hop.port}) failed: ${
      (err && err.message) || "connection error"
    }`,
  );
  out.code = (err && err.code) || "SSH_CONNECT_FAILED";
  out.hop = hopLabel;
  return out;
}

/** Open a forwarded `direct-tcpip` stream from a ready client to host:port. */
function forwardOut(client, srcHost, srcPort, dstHost, dstPort) {
  return new Promise((resolve, reject) => {
    client.forwardOut(srcHost, srcPort, dstHost, dstPort, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

/** Connect a single hop, optionally over a forwarded `sock` from the prior hop. */
function connectHop({ hop, hopLabel, sock, hostVerifier, readFileSync }) {
  return new Promise((resolve, reject) => {
    const authHandler = buildAuthHandler(hop, readFileSync);
    if (authHandler.length === 0) {
      reject(
        hopError(new Error("no usable authentication method"), hop, hopLabel),
      );
      return;
    }

    const client = new Client();
    let settled = false;

    client.on("ready", () => {
      settled = true;
      resolve(client);
    });
    client.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(hopError(err, hop, hopLabel));
    });

    try {
      client.connect({
        host: hop.host,
        port: hop.port,
        username: hop.user,
        sock, // undefined for the first hop → a direct TCP connection
        authHandler,
        hostVerifier,
        // We never fall back to keyboard-interactive prompts in a headless engine.
        tryKeyboard: false,
      });
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(hopError(err, hop, hopLabel));
      }
    }
  });
}

/**
 * Establish the full chain.
 *
 * @param {object} opts
 * @param {Array<object>} opts.hops  `[...jumps, sshServer]`, decrypted, in order
 * @param {string} opts.tunnelId
 * @param {(ctx: {host: string, port: number, hopLabel: string, tunnelId: string}) =>
 *          ((key: Buffer, verify: (ok: boolean) => void) => void)} opts.hostVerifierFactory
 * @param {typeof fs.readFileSync} [opts.readFileSync]  injectable for tests
 * @returns {Promise<{ client: import('ssh2').Client, dispose: () => void }>}
 */
async function connectChain({
  hops,
  tunnelId,
  hostVerifierFactory,
  readFileSync,
}) {
  if (!Array.isArray(hops) || hops.length === 0) {
    throw new Error("connectChain requires at least one hop");
  }

  const clients = [];
  const dispose = () => {
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // Ending an already-closed client is a no-op we don't care about.
      }
    }
  };

  try {
    let sock; // the forwarded stream feeding the next hop (undefined for the first)
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i];
      const hopLabel = i === hops.length - 1 ? "sshServer" : `jump[${i}]`;
      const hostVerifier = hostVerifierFactory({
        host: hop.host,
        port: hop.port,
        hopLabel,
        tunnelId,
      });

      const client = await connectHop({
        hop,
        hopLabel,
        sock,
        hostVerifier,
        readFileSync,
      });
      clients.push(client);

      if (i < hops.length - 1) {
        // Forward to the NEXT hop's SSH port and feed that stream in as its socket.
        const next = hops[i + 1];
        sock = await forwardOut(client, "127.0.0.1", 0, next.host, next.port);
      }
    }

    return { client: clients[clients.length - 1], dispose };
  } catch (err) {
    dispose();
    throw err;
  }
}

module.exports = {
  connectChain,
  forwardOut,
  buildAuthHandler,
  resolveAgent,
};
