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

import { resetDom, typeInto, change } from "./jsdom-setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { TunnelEditorDialog } from "../components/tunnel-editor-dialog.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

function stub(existing = []) {
  return {
    tunnels: { list: async () => existing },
    credentials: {
      list: async () => [{ id: "c1", label: "Prod", authType: "agent" }],
    },
    jumpHosts: { list: async () => [] },
  };
}

function mount({ existing = [], onSubmit, onSaved } = {}) {
  resetDom();
  return new TunnelEditorDialog({
    porthippo: stub(existing),
    onSubmit,
    onSaved,
  });
}

const q = (dlg, s) => dlg.element.querySelector(s);
const setInput = (dlg, key, value) =>
  typeInto(q(dlg, `.editor-input-${key}`), value);

// A minimal valid tunnel: Entry port only (loopback), a target server, a
// credential. Exit is left blank (→ 127.0.0.1 + the entry port).
function fillValid(dlg) {
  setInput(dlg, "name", "Prod DB");
  setInput(dlg, "entryAddress", "5432");
  setInput(dlg, "targetServer", "db.internal");
  change(q(dlg, ".cred-picker-select"), "c1");
}

test("openCreate shows the Entry/Target/Exit fields with Advanced collapsed", async () => {
  const dlg = mount();
  await dlg.openCreate();
  assert.ok(dlg.element.open);
  for (const key of ["name", "entryAddress", "targetServer", "exitAddress"]) {
    assert.ok(q(dlg, `.editor-input-${key}`), `${key} present`);
  }
  assert.ok(q(dlg, ".cred-picker-select"), "credential picker present");
  assert.equal(q(dlg, ".editor-advanced").open, false, "Advanced collapsed");
  // The old SSH-server / bind-address inputs are gone — folded into the fields.
  assert.equal(q(dlg, ".editor-input-sshHost"), null);
  assert.equal(q(dlg, ".editor-input-bindHost"), null);
});

test("buildPayload extracts bare ports into concrete fields + verbatim strings", async () => {
  const dlg = mount();
  await dlg.openCreate();
  fillValid(dlg);

  assert.deepEqual(dlg.buildPayload(), {
    name: "Prod DB",
    localPort: 5432,
    destination: { host: "127.0.0.1", port: 5432 },
    sshHost: "db.internal",
    credentialId: "c1",
    jumpHostIds: [],
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
    entryAddress: "5432",
  });
});

test("buildPayload extracts address:port fields (bind / bastion port / exit host)", async () => {
  const dlg = mount();
  await dlg.openCreate();
  setInput(dlg, "name", "LAN forward");
  setInput(dlg, "entryAddress", "0.0.0.0:80");
  setInput(dlg, "targetServer", "bastion:2222");
  setInput(dlg, "exitAddress", "db.local:5432");
  change(q(dlg, ".cred-picker-select"), "c1");

  assert.deepEqual(dlg.buildPayload(), {
    name: "LAN forward",
    localPort: 80,
    bindHost: "0.0.0.0",
    destination: { host: "db.local", port: 5432 },
    sshHost: "bastion",
    sshPort: 2222,
    credentialId: "c1",
    jumpHostIds: [],
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
    entryAddress: "0.0.0.0:80",
    exitAddress: "db.local:5432",
  });
});

test("a bare-host Exit defers its port to the entry port", async () => {
  const dlg = mount();
  await dlg.openCreate();
  fillValid(dlg);
  setInput(dlg, "exitAddress", "10.0.0.5");
  const payload = dlg.buildPayload();
  assert.deepEqual(payload.destination, { host: "10.0.0.5", port: 5432 });
});

test("a valid save submits the payload and fires onSaved, then closes", async () => {
  const calls = [];
  const dlg = mount({
    onSubmit: (payload, ctx) => (
      calls.push({ payload, ctx }),
      { id: "t1", ...payload }
    ),
    onSaved: (r) => calls.push({ saved: r }),
  });
  await dlg.openCreate();
  fillValid(dlg);

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();

  assert.equal(calls.length, 2, "onSubmit then onSaved");
  assert.equal(calls[0].ctx.id, null);
  assert.equal(calls[0].payload.sshHost, "db.internal");
  assert.ok(!dlg.element.open, "closed on success");
});

test("an invalid save flags each empty field inline and does not submit", async () => {
  const calls = [];
  const dlg = mount({ onSubmit: () => (calls.push(1), {}) });
  await dlg.openCreate();
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.length, 0);
  for (const key of ["name", "entryAddress", "targetServer", "credentialId"]) {
    assert.ok(
      q(dlg, `.field[data-error-key="${key}"]`).classList.contains(
        "field--error",
      ),
      `${key} flagged`,
    );
  }
});

test("a host-only Entry (no port) is flagged against the Entry field", async () => {
  const dlg = mount({ onSubmit: () => ({}) });
  await dlg.openCreate();
  fillValid(dlg);
  setInput(dlg, "entryAddress", "db.internal"); // a host with no port
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  const field = q(dlg, '.field[data-error-key="entryAddress"]');
  assert.ok(field.classList.contains("field--error"));
  assert.match(field.querySelector(".field-error").textContent, /port/i);
});

test("the Entry warning flags a conflict, then a privileged port", async () => {
  const dlg = mount({
    existing: [{ id: "other", name: "Redis", localPort: 6379 }],
  });
  await dlg.openCreate();
  const warn = q(dlg, ".editor-port-warning");

  setInput(dlg, "entryAddress", "6379");
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /Redis/);

  setInput(dlg, "entryAddress", "80"); // privileged, no conflict
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /1024/);

  setInput(dlg, "entryAddress", "8080"); // fine
  assert.equal(warn.hidden, true);
});

test("editing a tunnel that uses advanced fields opens Advanced", async () => {
  const dlg = mount();
  await dlg.openEdit({
    id: "t1",
    name: "Lingerer",
    localPort: 5432,
    destination: { host: "127.0.0.1", port: 5432 },
    sshHost: "db.internal",
    credentialId: "c1",
    jumpHostIds: [],
    lingerMs: 30000,
  });
  assert.equal(q(dlg, ".editor-advanced").open, true);
  assert.equal(q(dlg, ".editor-input-lingerMs").value, "30000");
});

test("openEdit round-trips the verbatim address strings when stored", async () => {
  const dlg = mount();
  await dlg.openEdit({
    id: "t1",
    name: "Stored",
    localPort: 80,
    bindHost: "0.0.0.0",
    destination: { host: "db.local", port: 5432 },
    sshHost: "bastion",
    sshPort: 2222,
    credentialId: "c1",
    jumpHostIds: [],
    entryAddress: "0.0.0.0:80",
    exitAddress: "db.local:5432",
  });
  assert.equal(q(dlg, ".editor-input-entryAddress").value, "0.0.0.0:80");
  assert.equal(q(dlg, ".editor-input-targetServer").value, "bastion:2222");
  assert.equal(q(dlg, ".editor-input-exitAddress").value, "db.local:5432");
});

test("openEdit reconstructs the fields for a legacy record without raw strings", async () => {
  const dlg = mount();
  await dlg.openEdit({
    id: "t1",
    name: "Legacy bastion",
    localPort: 5432,
    destination: { host: "db.local", port: 6000 },
    sshHost: "bastion",
    sshPort: 2222,
    credentialId: "c1",
    jumpHostIds: [],
  });
  assert.equal(q(dlg, ".editor-input-entryAddress").value, "5432");
  assert.equal(q(dlg, ".editor-input-targetServer").value, "bastion:2222");
  assert.equal(q(dlg, ".editor-input-exitAddress").value, "db.local:6000");
});

test("editing a tunnel whose credential was deleted drops the stale id", async () => {
  const dlg = mount(); // the stub's credential list only has "c1"
  await dlg.openEdit({
    id: "t1",
    name: "Orphaned",
    localPort: 5432,
    destination: { host: "127.0.0.1", port: 5432 },
    sshHost: "db.internal",
    credentialId: "gone", // references a credential that no longer exists
    jumpHostIds: [],
  });
  assert.equal(dlg.buildPayload().credentialId, "");
});

// ── Resolution validation (Feature 100) ──────────────────────────────────────

const waitUntil = async (pred, timeout = 2000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function mountResolve({ lookup, bindcheck, test: testFn, existing = [] } = {}) {
  resetDom();
  const calls = { lookup: [], bindcheck: [], test: [], cancel: 0 };
  const porthippo = {
    ...stub(existing),
    resolve: {
      lookup: async (host) => {
        calls.lookup.push(host);
        return lookup ? lookup(host) : { resolved: true };
      },
      bindcheck: async (host) => {
        calls.bindcheck.push(host);
        return bindcheck ? bindcheck(host) : { resolved: true, local: true };
      },
      test: async (payload) => {
        calls.test.push(payload);
        return testFn
          ? testFn(payload)
          : { ok: true, hops: [], destination: null };
      },
      cancel: async () => {
        calls.cancel++;
        return { ok: true };
      },
    },
  };
  const dlg = new TunnelEditorDialog({ porthippo });
  return { dlg, calls };
}

const blockWarn = (dlg, inputKey) =>
  q(dlg, `.editor-input-${inputKey}`)
    .closest(".editor-block")
    .querySelector(".editor-resolve-warning");

test("an unresolvable target server raises a soft warning that clears when it resolves", async () => {
  const { dlg } = mountResolve({
    lookup: (host) => ({ resolved: host !== "bad.invalid" }),
  });
  await dlg.openEdit({
    id: "t1",
    name: "Bad target",
    localPort: 5432,
    destination: { host: "127.0.0.1", port: 5432 },
    sshHost: "bad.invalid",
    credentialId: "c1",
    jumpHostIds: [],
  });

  const warn = blockWarn(dlg, "targetServer");
  await waitUntil(() => warn.hidden === false);
  assert.match(warn.textContent, /bad\.invalid/);

  setInput(dlg, "targetServer", "good.example.com");
  await waitUntil(() => warn.hidden === true);

  // ...and a save is never blocked by resolution — advisory only.
  assert.equal(dlg.buildPayload().sshHost, "good.example.com");
});

test("an Entry host that isn't a local address raises a soft warning", async () => {
  const { dlg, calls } = mountResolve({
    bindcheck: (host) => ({
      resolved: true,
      local: host === "127.0.0.1",
      address: host,
    }),
  });
  await dlg.openCreate();
  setInput(dlg, "entryAddress", "10.0.0.9:80");

  const warn = blockWarn(dlg, "entryAddress");
  await waitUntil(() => warn.hidden === false);
  assert.match(warn.textContent, /this machine/);
  assert.ok(calls.bindcheck.includes("10.0.0.9"));
});

test("an IP-literal target never triggers a DNS lookup", async () => {
  const { dlg, calls } = mountResolve();
  await dlg.openEdit({
    id: "t1",
    name: "By IP",
    localPort: 5432,
    destination: { host: "127.0.0.1", port: 5432 },
    sshHost: "10.0.0.9",
    credentialId: "c1",
    jumpHostIds: [],
  });
  await waitUntil(() => true);
  assert.ok(!calls.lookup.includes("10.0.0.9"), "IP literal short-circuits");
  assert.equal(blockWarn(dlg, "targetServer").hidden, true);
});

test("Test resolution runs the probe and renders a per-hop result", async () => {
  const { dlg, calls } = mountResolve({
    test: () => ({
      ok: false,
      hops: [
        { hopLabel: "sshServer", host: "db.internal", port: 22, status: "ok" },
      ],
      destination: {
        host: "127.0.0.1",
        port: 5432,
        status: "fail",
        reason: "refused",
      },
    }),
  });
  await dlg.openCreate();
  fillValid(dlg);

  q(dlg, ".editor-resolve-btn").click();
  await waitUntil(() => q(dlg, ".editor-resolve-results").hidden === false);
  await waitUntil(
    () => dlg.element.querySelectorAll(".editor-resolve-row").length === 2,
  );

  assert.equal(calls.test.length, 1, "the probe was invoked once");
  const rows = [...dlg.element.querySelectorAll(".editor-resolve-row")];
  assert.match(rows[0].textContent, /Target server/);
  assert.match(rows[0].textContent, /reachable/);
  assert.match(rows[1].textContent, /Exit/);
  assert.match(rows[1].textContent, /unreachable/);
  assert.match(rows[1].textContent, /refused/);
});

test("a failing resolution never blocks the save", async () => {
  const calls = [];
  resetDom();
  const dlg = new TunnelEditorDialog({
    porthippo: {
      ...stub(),
      resolve: {
        lookup: async () => ({ resolved: false }),
        bindcheck: async () => ({ resolved: false, local: false }),
        test: async () => ({ ok: false, hops: [], destination: null }),
        cancel: async () => ({ ok: true }),
      },
    },
    onSubmit: (payload) => (calls.push(payload), { id: "t1", ...payload }),
  });
  await dlg.openCreate();
  fillValid(dlg);
  await waitUntil(() => blockWarn(dlg, "targetServer").hidden === false);

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.length, 1, "save proceeds despite the unresolved warning");
});

test("a store __hippoError maps a concrete-field error onto the owning field", async () => {
  const dlg = mount({
    onSubmit: () => ({
      __hippoError: true,
      code: "INVALID_DEFINITION",
      errors: { "destination.port": "bad port" },
    }),
  });
  await dlg.openCreate();
  fillValid(dlg);
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  // destination.* belongs to the Exit field now.
  assert.ok(
    q(dlg, '.field[data-error-key="exitAddress"]').classList.contains(
      "field--error",
    ),
  );
  assert.ok(
    dlg.element.open,
    "the dialog stays open so the error can be fixed",
  );
});
