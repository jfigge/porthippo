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
 * resolve-check.test.js — the local DNS resolvability helper (Feature 100).
 *
 * `dns.lookup` is injected so the tests never touch the real resolver: they assert
 * the resolved/unresolved mapping and the empty / IP-literal short-circuits (which
 * must NOT call the resolver at all).
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { lookupHost } = require("../resolve-check");

test("a name that resolves returns its address", async () => {
  let calls = 0;
  const lookup = (host, _opts, cb) => {
    calls++;
    cb(null, "203.0.113.7", 4);
  };
  const res = await lookupHost("db.example.com", { lookup });
  assert.deepEqual(res, { resolved: true, address: "203.0.113.7", family: 4 });
  assert.equal(calls, 1);
});

test("an NXDOMAIN name is reported unresolved with the error code", async () => {
  const lookup = (host, _opts, cb) => {
    const err = new Error("getaddrinfo ENOTFOUND nope.invalid");
    err.code = "ENOTFOUND";
    cb(err);
  };
  const res = await lookupHost("nope.invalid", { lookup });
  assert.equal(res.resolved, false);
  assert.equal(res.reason, "ENOTFOUND");
});

test("an empty host short-circuits to resolved without a lookup", async () => {
  let calls = 0;
  const lookup = () => calls++;
  const res = await lookupHost("   ", { lookup });
  assert.deepEqual(res, { resolved: true });
  assert.equal(calls, 0, "the resolver is never called for an empty host");
});

test("an IPv4 literal is resolved without a lookup", async () => {
  let calls = 0;
  const lookup = () => calls++;
  const res = await lookupHost("10.0.0.5", { lookup });
  assert.deepEqual(res, { resolved: true, address: "10.0.0.5", family: 4 });
  assert.equal(calls, 0);
});

test("an IPv6 literal is resolved without a lookup", async () => {
  let calls = 0;
  const lookup = () => calls++;
  const res = await lookupHost("::1", { lookup });
  assert.equal(res.resolved, true);
  assert.equal(res.family, 6);
  assert.equal(calls, 0);
});
