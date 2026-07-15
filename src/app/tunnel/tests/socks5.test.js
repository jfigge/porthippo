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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  Socks5Handshake,
  replyBuffer,
  successReply,
  forwardErrorToRep,
  REP,
} = require("../socks5");

const b = (...bytes) => Buffer.from(bytes);
const GREETING = b(0x05, 0x01, 0x00); // one method: no-auth

test("parses a greeting + IPv4 CONNECT request in one feed", () => {
  const hs = new Socks5Handshake();
  const req = b(0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50); // 1.2.3.4:80
  const res = hs.feed(Buffer.concat([GREETING, req]));
  assert.equal(res.status, "request");
  assert.deepEqual([...res.send], [0x05, 0x00], "method-selection reply");
  assert.deepEqual(res.request, { cmd: 1, dstHost: "1.2.3.4", dstPort: 80 });
  assert.equal(res.leftover.length, 0);
});

test("splits the greeting reply from a later request across feeds", () => {
  const hs = new Socks5Handshake();
  const g = hs.feed(GREETING);
  assert.equal(g.status, "need-more");
  assert.deepEqual(
    [...g.send],
    [0x05, 0x00],
    "greeting reply owed immediately",
  );

  const r = hs.feed(b(0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90));
  assert.equal(r.status, "request");
  assert.equal(r.send, undefined, "greeting reply not resent");
  assert.deepEqual(r.request, { cmd: 1, dstHost: "127.0.0.1", dstPort: 8080 });
});

test("waits for more bytes when the greeting is incomplete", () => {
  const hs = new Socks5Handshake();
  const res = hs.feed(b(0x05, 0x02, 0x00)); // says 2 methods, only 1 present
  assert.equal(res.status, "need-more");
  assert.equal(res.send, undefined);
});

test("parses a domain-name CONNECT target", () => {
  const hs = new Socks5Handshake();
  hs.feed(GREETING);
  const host = "example.com";
  const req = Buffer.concat([
    b(0x05, 0x01, 0x00, 0x03, host.length),
    Buffer.from(host, "utf8"),
    b(0x01, 0xbb), // port 443
  ]);
  const res = hs.feed(req);
  assert.deepEqual(res.request, {
    cmd: 1,
    dstHost: "example.com",
    dstPort: 443,
  });
});

test("parses an IPv6 CONNECT target", () => {
  const hs = new Socks5Handshake();
  hs.feed(GREETING);
  const addr = Buffer.alloc(16);
  addr[15] = 1; // ::1
  const req = Buffer.concat([b(0x05, 0x01, 0x00, 0x04), addr, b(0x00, 0x16)]);
  const res = hs.feed(req);
  assert.equal(res.status, "request");
  assert.equal(res.request.dstHost, "0:0:0:0:0:0:0:1");
  assert.equal(res.request.dstPort, 22);
});

test("preserves application bytes received after the request as leftover", () => {
  const hs = new Socks5Handshake();
  hs.feed(GREETING);
  const req = b(0x05, 0x01, 0x00, 0x01, 10, 0, 0, 5, 0x00, 0x50);
  const app = b(0xde, 0xad, 0xbe, 0xef);
  const res = hs.feed(Buffer.concat([req, app]));
  assert.deepEqual([...res.leftover], [0xde, 0xad, 0xbe, 0xef]);
});

test("rejects a greeting that offers no no-auth method", () => {
  const hs = new Socks5Handshake();
  const res = hs.feed(b(0x05, 0x01, 0x02)); // only GSSAPI (0x02)
  assert.equal(res.status, "error");
  assert.deepEqual([...res.send], [0x05, 0xff], "no-acceptable-methods reply");
});

test("rejects a non-CONNECT command with COMMAND_NOT_SUPPORTED", () => {
  const hs = new Socks5Handshake();
  hs.feed(GREETING);
  const res = hs.feed(b(0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50)); // BIND
  assert.equal(res.status, "error");
  assert.equal(res.rep, REP.COMMAND_NOT_SUPPORTED);
});

test("rejects an unsupported address type", () => {
  const hs = new Socks5Handshake();
  hs.feed(GREETING);
  const res = hs.feed(b(0x05, 0x01, 0x00, 0x09, 0, 0)); // ATYP 0x09
  assert.equal(res.status, "error");
  assert.equal(res.rep, REP.ADDRESS_TYPE_NOT_SUPPORTED);
});

test("rejects a non-SOCKS5 greeting version", () => {
  const hs = new Socks5Handshake();
  const res = hs.feed(b(0x04, 0x01, 0x00));
  assert.equal(res.status, "error");
  assert.equal(res.rep, REP.GENERAL_FAILURE);
});

test("reply builders and error mapping", () => {
  assert.deepEqual(
    [...successReply()],
    [0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(
    [...replyBuffer(REP.HOST_UNREACHABLE)][1],
    REP.HOST_UNREACHABLE,
  );
  assert.equal(
    forwardErrorToRep({ code: "ECONNREFUSED" }),
    REP.CONNECTION_REFUSED,
  );
  assert.equal(forwardErrorToRep({ code: "ENOTFOUND" }), REP.HOST_UNREACHABLE);
  assert.equal(forwardErrorToRep(new Error("nope")), REP.GENERAL_FAILURE);
});
