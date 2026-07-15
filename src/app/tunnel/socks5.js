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
 * socks5.js — a minimal, dependency-free SOCKS5 handshake parser for the dynamic
 * (SOCKS proxy) forwarding type (Feature 110). It is CONNECT + no-auth only: the
 * two SOCKS phases a browser/app performs before its application bytes flow, done
 * with our own bytes so we never shell out to a SOCKS proxy (the same posture as
 * "never shell out to system ssh").
 *
 * `Socks5Handshake` is a pure byte state machine — no sockets, no I/O — so it is
 * unit-testable against raw buffers. The caller (`relay.js` `startSocksRelay`)
 * feeds it inbound chunks and acts on the result:
 *   - writes any `send` buffer back to the client (the method-selection reply),
 *   - on `request`, forwards a `direct-tcpip` channel to `dstHost:dstPort` through
 *     the SSH chain, then itself writes the success/failure reply (built here) —
 *     the parser can't know whether the forward succeeded, so it never writes it,
 *   - forwards `leftover` (any application bytes received alongside the request).
 *
 * Protocol (RFC 1928):
 *   greeting  client → VER(0x05) NMETHODS METHOD…    server → VER METHOD
 *   request   client → VER CMD RSV(0x00) ATYP ADDR PORT
 *   reply     server → VER REP RSV(0x00) ATYP BND.ADDR BND.PORT
 * BIND / UDP ASSOCIATE and every auth method other than no-auth are refused with
 * the correct reply.
 */
"use strict";

const SOCKS_VERSION = 0x05;
const NO_AUTH = 0x00;
const NO_ACCEPTABLE_AUTH = 0xff;

/** SOCKS5 CMD codes (we support CONNECT only). */
const CMD = { CONNECT: 0x01, BIND: 0x02, UDP_ASSOCIATE: 0x03 };

/** SOCKS5 ATYP codes. */
const ATYP = { IPV4: 0x01, DOMAIN: 0x03, IPV6: 0x04 };

/** SOCKS5 REP (reply) codes. */
const REP = {
  SUCCESS: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
};

/**
 * Build a SOCKS5 reply with the given REP code. The bound address is reported as
 * IPv4 `0.0.0.0:0`, which every conformant client accepts (they route by the REP
 * code, not the bound address, for a CONNECT).
 * @param {number} rep  a REP.* code
 * @returns {Buffer}
 */
function replyBuffer(rep) {
  return Buffer.from([SOCKS_VERSION, rep, 0x00, ATYP.IPV4, 0, 0, 0, 0, 0, 0]);
}

/** The success reply the caller writes once its forwarded channel is open. */
function successReply() {
  return replyBuffer(REP.SUCCESS);
}

/**
 * Map a `forwardOut` failure to the closest SOCKS REP code so the client sees a
 * meaningful proxy error rather than a bare disconnect. Best-effort by `.code`.
 * @param {any} err
 * @returns {number}
 */
function forwardErrorToRep(err) {
  const code = err && (err.code || err.reason);
  if (code === "ECONNREFUSED") return REP.CONNECTION_REFUSED;
  if (code === "EHOSTUNREACH" || code === "ENOTFOUND")
    return REP.HOST_UNREACHABLE;
  if (code === "ENETUNREACH") return REP.NETWORK_UNREACHABLE;
  if (code === "ETIMEDOUT") return REP.TTL_EXPIRED;
  return REP.GENERAL_FAILURE;
}

/** Render a request address (IPv4 / domain / IPv6) into a connectable host. */
function readAddress(atyp, buf, offset) {
  if (atyp === ATYP.IPV4) {
    if (buf.length < offset + 4) return null;
    const host = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
    return { host, next: offset + 4 };
  }
  if (atyp === ATYP.DOMAIN) {
    if (buf.length < offset + 1) return null;
    const len = buf[offset];
    if (buf.length < offset + 1 + len) return null;
    const host = buf.toString("utf8", offset + 1, offset + 1 + len);
    return { host, next: offset + 1 + len };
  }
  if (atyp === ATYP.IPV6) {
    if (buf.length < offset + 16) return null;
    const parts = [];
    for (let i = 0; i < 16; i += 2) {
      parts.push(buf.readUInt16BE(offset + i).toString(16));
    }
    return { host: parts.join(":"), next: offset + 16 };
  }
  return null; // unsupported ATYP
}

/**
 * Incremental SOCKS5 greeting + request parser. Feed it inbound chunks; each
 * `feed()` processes as much as is buffered and returns what the caller should do.
 */
class Socks5Handshake {
  #buf = Buffer.alloc(0);
  #phase = "greeting"; // greeting → request → done

  /**
   * @param {Buffer} chunk  the next inbound bytes
   * @returns {{
   *   status: "need-more"|"request"|"error",
   *   send?: Buffer,        // bytes to write back to the client now
   *   request?: { cmd: number, dstHost: string, dstPort: number },
   *   leftover?: Buffer,    // application bytes received after the request
   *   rep?: number,         // on error, the REP code (send `replyBuffer(rep)`)
   *   message?: string,     // on error, a short reason
   * }}
   */
  feed(chunk) {
    if (chunk && chunk.length) {
      this.#buf = Buffer.concat([this.#buf, chunk]);
    }
    let send;

    if (this.#phase === "greeting") {
      const g = this.#parseGreeting();
      if (g.status === "need-more") return { status: "need-more" };
      if (g.status === "error") return g;
      send = g.send; // the method-selection reply
      this.#phase = "request";
    }

    if (this.#phase === "request") {
      const r = this.#parseRequest();
      if (r.status === "need-more") {
        // A pipelined method reply may still be owed even though the request
        // isn't complete yet — hand it over so the client isn't left waiting.
        return send ? { status: "need-more", send } : { status: "need-more" };
      }
      if (r.status === "error") return send ? { ...r, send } : r;
      this.#phase = "done";
      return send ? { ...r, send } : r;
    }

    return { status: "need-more" };
  }

  #parseGreeting() {
    const buf = this.#buf;
    if (buf.length < 2) return { status: "need-more" };
    if (buf[0] !== SOCKS_VERSION) {
      return {
        status: "error",
        rep: REP.GENERAL_FAILURE,
        message: "not a SOCKS5 greeting",
      };
    }
    const nMethods = buf[1];
    if (buf.length < 2 + nMethods) return { status: "need-more" };
    const methods = buf.subarray(2, 2 + nMethods);
    this.#buf = buf.subarray(2 + nMethods);
    if (!methods.includes(NO_AUTH)) {
      // No acceptable method — tell the client and let the caller close.
      return {
        status: "error",
        send: Buffer.from([SOCKS_VERSION, NO_ACCEPTABLE_AUTH]),
        rep: REP.NOT_ALLOWED,
        message: "no acceptable SOCKS auth method (only no-auth is supported)",
      };
    }
    return { status: "greeting", send: Buffer.from([SOCKS_VERSION, NO_AUTH]) };
  }

  #parseRequest() {
    const buf = this.#buf;
    if (buf.length < 4) return { status: "need-more" };
    if (buf[0] !== SOCKS_VERSION) {
      return {
        status: "error",
        rep: REP.GENERAL_FAILURE,
        message: "malformed SOCKS5 request",
      };
    }
    const cmd = buf[1];
    const atyp = buf[3];
    const addr = readAddress(atyp, buf, 4);
    if (addr === null) {
      // Either not enough bytes yet, or an unsupported ATYP.
      if (atyp !== ATYP.IPV4 && atyp !== ATYP.DOMAIN && atyp !== ATYP.IPV6) {
        return {
          status: "error",
          rep: REP.ADDRESS_TYPE_NOT_SUPPORTED,
          message: "unsupported SOCKS address type",
        };
      }
      return { status: "need-more" };
    }
    if (buf.length < addr.next + 2) return { status: "need-more" };
    const dstPort = buf.readUInt16BE(addr.next);
    const leftover = buf.subarray(addr.next + 2);
    this.#buf = Buffer.alloc(0);

    if (cmd !== CMD.CONNECT) {
      return {
        status: "error",
        rep: REP.COMMAND_NOT_SUPPORTED,
        message: "only the SOCKS CONNECT command is supported",
      };
    }
    return {
      status: "request",
      request: { cmd, dstHost: addr.host, dstPort },
      leftover: Buffer.from(leftover), // detach from the internal buffer
    };
  }
}

module.exports = {
  Socks5Handshake,
  replyBuffer,
  successReply,
  forwardErrorToRep,
  SOCKS_VERSION,
  CMD,
  ATYP,
  REP,
};
