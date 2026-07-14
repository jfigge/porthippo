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
const os = require("os");

/** Addresses that always bind to the local machine, regardless of interfaces. */
const WILDCARD = new Set(["0.0.0.0", "::", "::0"]);

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

/** True when `address` is a loopback literal (127/8 or ::1). */
function isLoopbackAddress(address) {
  if (address === "::1") return true;
  return net.isIPv4(address) && address.startsWith("127.");
}

/** Every IPv4/IPv6 address currently assigned to a local interface. */
function localInterfaceAddresses(interfaces) {
  const set = new Set();
  for (const list of Object.values(interfaces || {})) {
    for (const iface of list || []) {
      if (iface && typeof iface.address === "string") set.add(iface.address);
    }
  }
  return set;
}

/**
 * Classify the Entry-port bind host: does it resolve *and* name an address this
 * machine can actually bind to (loopback, a wildcard, or one of its own
 * interface addresses)? The tunnel's local listener can only bind local
 * addresses, so a name pointing anywhere else is rejected before arm time.
 *
 * An empty host is "the default loopback" — resolvable and local. An IP literal
 * is checked directly (no DNS); a hostname is resolved first, then its address
 * is checked. A name that resolves off-box comes back `{ resolved: true, local:
 * false }` so the editor can explain *why* it can't be used.
 *
 * @param {string} host
 * @param {object} [deps]
 * @param {(hostname: string, opts: object, cb: Function) => void} [deps.lookup]
 * @param {() => Object} [deps.networkInterfaces]  injectable for tests
 * @returns {Promise<{ resolved: boolean, local: boolean, address?: string, reason?: string }>}
 */
async function classifyBindHost(
  host,
  { lookup = dns.lookup, networkInterfaces = os.networkInterfaces } = {},
) {
  const name = typeof host === "string" ? host.trim() : "";
  if (name === "") return { resolved: true, local: true };

  const res = await lookupHost(name, { lookup });
  if (!res.resolved) {
    return { resolved: false, local: false, reason: res.reason };
  }

  const address = res.address || name;
  const local =
    WILDCARD.has(address) ||
    isLoopbackAddress(address) ||
    localInterfaceAddresses(networkInterfaces()).has(address);
  return { resolved: true, local, address };
}

module.exports = { lookupHost, classifyBindHost };
