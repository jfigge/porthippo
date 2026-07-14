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
 * resolve-check.js — local DNS resolvability check (Feature 100).
 *
 * `lookupHost(host)` answers the editor's "does this name resolve *from this
 * machine*?" question for the names a tunnel resolves locally — the local bind
 * address and the first hop. It is deliberately NOT on the engine hot path: it
 * never connects anything, it just asks the OS resolver.
 *
 * Names that resolve only on the far side of the chain (the destination, and any
 * hop past the first) are validated by the resolution *probe* instead
 * (`ssh-chain.probeChain`), never here — a local lookup of an internal name would
 * mislead. An empty field has nothing to warn about, and an IP literal is already
 * "resolved", so both short-circuit without hitting DNS.
 */
"use strict";

const dns = require("dns");
const net = require("net");

/**
 * Resolve `host` locally to an address.
 *
 * @param {string} host
 * @param {object} [deps]
 * @param {(hostname: string, opts: object, cb: Function) => void} [deps.lookup]
 *        injectable `dns.lookup` for tests.
 * @returns {Promise<{ resolved: boolean, address?: string, family?: number, reason?: string }>}
 */
function lookupHost(host, { lookup = dns.lookup } = {}) {
  const name = typeof host === "string" ? host.trim() : "";
  // An empty field carries nothing to warn about; an IP literal is its own answer.
  if (name === "") return Promise.resolve({ resolved: true });
  const ipFamily = net.isIP(name);
  if (ipFamily !== 0) {
    return Promise.resolve({ resolved: true, address: name, family: ipFamily });
  }

  return new Promise((resolve) => {
    lookup(name, { all: false }, (err, address, family) => {
      if (err) {
        resolve({
          resolved: false,
          reason: err.code || err.message || "lookup failed",
        });
      } else {
        resolve({ resolved: true, address, family });
      }
    });
  });
}

module.exports = { lookupHost };
