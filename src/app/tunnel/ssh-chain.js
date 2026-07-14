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

/** The friendly hop label used everywhere the chain is reported. */
function hopLabelFor(index, count) {
  return index === count - 1 ? "sshServer" : `jump[${index}]`;
}

/**
 * Walk the chain the way `connectChain` does, but instead of throwing at the first
 * failure, report a **per-hop** resolvability/reachability result and then probe the
 * destination from the far end — the Feature 100 "Test resolution" path.
 *
 * Each hop is validated from its real vantage point: hop 0 over plain TCP (local
 * resolution), each later hop over a `forwardOut` from the previous hop (resolution
 * *there*), and finally the destination over a `forwardOut` from the last hop
 * (resolution on the SSH server). A hop that can't be SSH-connected, or that the
 * previous hop can't `forwardOut` to, is the resolvability/reachability failure for
 * that hop; every hop past the first failure is `skipped`. Nothing is relayed — the
 * destination probe channel is opened only to prove it can be, then closed.
 *
 * Host-key verification runs through the same injected `hostVerifierFactory` as a
 * real connection, so an unknown key prompts (and, once trusted, is persisted) here
 * too — which is what makes a passing hop a genuine validation of that jump host.
 *
 * Resolves (never rejects for an expected failure) to
 * `{ ok, hops: [{ hopLabel, host, port, status:"ok"|"fail"|"skipped", reason? }],
 *    destination: { host, port, status, reason? } }`. Always disposes every hop.
 *
 * @param {object} opts
 * @param {Array<object>} opts.hops         `[...jumps, sshServer]`, decrypted, in order
 * @param {{host: string, port: number}} opts.destination  the far target to probe
 * @param {string} opts.tunnelId
 * @param {Function} opts.hostVerifierFactory  same factory `connectChain` takes
 * @param {typeof fs.readFileSync} [opts.readFileSync]
 * @param {AbortSignal} [opts.signal]        abort → dispose the in-flight chain
 * @returns {Promise<object>}
 */
async function probeChain({
  hops,
  destination,
  tunnelId,
  hostVerifierFactory,
  readFileSync,
  signal,
}) {
  const count = Array.isArray(hops) ? hops.length : 0;
  const entryFor = (i) => ({
    hopLabel: hopLabelFor(i, count),
    host: hops[i]?.host ?? "",
    port: hops[i]?.port,
  });
  const result = { ok: false, hops: [], destination: null };
  const dest = destination || {};

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
  // An abort ends every open hop, which makes any in-flight connect/forward reject
  // and unwinds the walk without leaving a connection behind.
  const onAbort = () => dispose();
  signal?.addEventListener("abort", onAbort, { once: true });

  // Mark hop `from` (inclusive) through the destination as not-tested.
  const skipRest = (from) => {
    for (let j = from; j < count; j++) {
      result.hops.push({ ...entryFor(j), status: "skipped" });
    }
    result.destination = {
      host: dest.host,
      port: dest.port,
      status: "skipped",
    };
  };

  try {
    if (count === 0) {
      result.destination = {
        host: dest.host,
        port: dest.port,
        status: "skipped",
      };
      return result;
    }

    let sock; // the forwarded stream feeding the next hop (undefined for the first)
    for (let i = 0; i < count; i++) {
      if (signal?.aborted) {
        skipRest(i);
        return result;
      }
      const hop = hops[i];
      const hopLabel = hopLabelFor(i, count);
      const hostVerifier = hostVerifierFactory({
        host: hop.host,
        port: hop.port,
        hopLabel,
        tunnelId,
      });

      let client;
      try {
        client = await connectHop({
          hop,
          hopLabel,
          sock,
          hostVerifier,
          readFileSync,
        });
      } catch (err) {
        result.hops.push({
          ...entryFor(i),
          status: "fail",
          reason: (err && err.message) || "connection failed",
        });
        skipRest(i + 1);
        return result;
      }
      clients.push(client);
      result.hops.push({ ...entryFor(i), status: "ok" });

      if (i < count - 1) {
        // Reaching hop i+1 means hop i could resolve+connect to it — validating it.
        const next = hops[i + 1];
        try {
          sock = await forwardOut(client, "127.0.0.1", 0, next.host, next.port);
        } catch (err) {
          result.hops.push({
            ...entryFor(i + 1),
            status: "fail",
            reason: (err && err.message) || "unreachable from the previous hop",
          });
          skipRest(i + 2);
          return result;
        }
      }
    }

    // Every hop connected — probe the destination from the final (sshServer) hop.
    if (signal?.aborted) {
      result.destination = {
        host: dest.host,
        port: dest.port,
        status: "skipped",
      };
      return result;
    }
    const finalClient = clients[clients.length - 1];
    try {
      const stream = await forwardOut(
        finalClient,
        "127.0.0.1",
        0,
        dest.host,
        dest.port,
      );
      // Never relay a byte — opening the channel already proved resolve+reach.
      try {
        stream.end();
        stream.destroy();
      } catch {
        // stream already torn down
      }
      result.destination = { host: dest.host, port: dest.port, status: "ok" };
      result.ok = true;
    } catch (err) {
      result.destination = {
        host: dest.host,
        port: dest.port,
        status: "fail",
        reason: (err && err.message) || "unreachable",
      };
    }
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    dispose();
  }
}

module.exports = {
  connectChain,
  probeChain,
  forwardOut,
  buildAuthHandler,
  resolveAgent,
};
