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

function fillValid(dlg) {
  setInput(dlg, "name", "Prod DB");
  setInput(dlg, "destHost", "db.internal");
  setInput(dlg, "destPort", "5432");
  setInput(dlg, "localPort", "5432");
  change(q(dlg, ".cred-picker-select"), "c1");
}

test("openCreate shows the primary fields with Advanced collapsed", async () => {
  const dlg = mount();
  await dlg.openCreate();
  assert.ok(dlg.element.open);
  for (const key of ["name", "destHost", "destPort", "localPort"]) {
    assert.ok(q(dlg, `.editor-input-${key}`), `${key} present`);
  }
  assert.ok(q(dlg, ".cred-picker-select"), "credential picker present");
  assert.equal(q(dlg, ".editor-advanced").open, false, "Advanced collapsed");
  // Local host + SSH server live only inside Advanced.
  assert.ok(q(dlg, ".editor-input-bindHost"));
  assert.ok(q(dlg, ".editor-input-sshHost"));
});

test("buildPayload assembles the reference-shape definition", async () => {
  const dlg = mount();
  await dlg.openCreate();
  fillValid(dlg);
  q(dlg, ".editor-advanced").open = true;
  setInput(dlg, "sshHost", "bastion");
  setInput(dlg, "sshPort", "2222");

  assert.deepEqual(dlg.buildPayload(), {
    name: "Prod DB",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    credentialId: "c1",
    jumpHostIds: [],
    keepAlive: false,
    enabled: true,
    autoReconnect: false,
    sshHost: "bastion",
    sshPort: 2222,
  });
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
  assert.equal(calls[0].payload.credentialId, "c1");
  assert.ok(!dlg.element.open, "closed on success");
});

test("an invalid save shows inline errors and does not submit", async () => {
  const calls = [];
  const dlg = mount({ onSubmit: () => (calls.push(1), {}) });
  await dlg.openCreate();
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.length, 0);
  for (const key of ["name", "localPort", "credentialId"]) {
    assert.ok(
      q(dlg, `.field[data-error-key="${key}"]`).classList.contains(
        "field--error",
      ),
      `${key} flagged`,
    );
  }
});

test("the local-port warning flags a conflict, then a privileged port", async () => {
  const dlg = mount({
    existing: [{ id: "other", name: "Redis", localPort: 6379 }],
  });
  await dlg.openCreate();
  const warn = q(dlg, ".editor-port-warning");

  setInput(dlg, "localPort", "6379");
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /Redis/);

  setInput(dlg, "localPort", "80"); // privileged, no conflict
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /1024/);

  setInput(dlg, "localPort", "8080"); // fine
  assert.equal(warn.hidden, true);
});

test("editing a tunnel that uses advanced fields opens Advanced", async () => {
  const dlg = mount();
  await dlg.openEdit({
    id: "t1",
    name: "Bastioned",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    credentialId: "c1",
    jumpHostIds: [],
    sshHost: "bastion",
  });
  assert.equal(q(dlg, ".editor-advanced").open, true);
  assert.equal(q(dlg, ".editor-input-sshHost").value, "bastion");
});

test("editing a tunnel whose credential was deleted drops the stale id from the payload", async () => {
  const dlg = mount(); // the stub's credential list only has "c1"
  await dlg.openEdit({
    id: "t1",
    name: "Orphaned",
    localPort: 5432,
    destination: { host: "db.internal", port: 5432 },
    credentialId: "gone", // references a credential that no longer exists
    jumpHostIds: [],
  });
  // The picker rejected the missing id, so buildPayload must send "" (the live
  // picker value), not the stale #form.credentialId the store would reject.
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

function mountResolve({ lookup, test: testFn, existing = [] } = {}) {
  resetDom();
  const calls = { lookup: [], test: [], cancel: 0 };
  const porthippo = {
    ...stub(existing),
    resolve: {
      lookup: async (host) => {
        calls.lookup.push(host);
        return lookup ? lookup(host) : { resolved: true };
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

const destWarn = (dlg) =>
  q(dlg, ".editor-input-destHost")
    .closest(".editor-block")
    .querySelector(".editor-resolve-warning");

test("an unresolvable first-hop host raises a soft warning that clears when it resolves", async () => {
  const { dlg } = mountResolve({
    lookup: (host) => ({ resolved: host !== "bad.invalid" }),
  });
  await dlg.openEdit({
    id: "t1",
    name: "Bad host",
    localPort: 5432,
    destination: { host: "bad.invalid", port: 5432 },
    credentialId: "c1",
    jumpHostIds: [],
  });

  // No bastion + no jumps ⇒ the destination is the first (locally-resolved) hop.
  await waitUntil(() => destWarn(dlg).hidden === false);
  assert.match(destWarn(dlg).textContent, /bad\.invalid/);

  setInput(dlg, "destHost", "good.example.com");
  await waitUntil(() => destWarn(dlg).hidden === true);

  // ...and a save is never blocked by resolution — advisory only.
  assert.equal(dlg.buildPayload().destination.host, "good.example.com");
});

test("an IP-literal host never triggers a DNS lookup", async () => {
  const { dlg, calls } = mountResolve();
  await dlg.openEdit({
    id: "t1",
    name: "By IP",
    localPort: 5432,
    destination: { host: "10.0.0.9", port: 5432 },
    credentialId: "c1",
    jumpHostIds: [],
  });
  await waitUntil(() => true); // let any scheduled check settle
  assert.ok(
    !calls.lookup.includes("10.0.0.9"),
    "an IP literal short-circuits without a lookup",
  );
  assert.equal(destWarn(dlg).hidden, true);
});

test("Test resolution runs the probe and renders a per-hop result", async () => {
  const { dlg, calls } = mountResolve({
    test: () => ({
      ok: false,
      hops: [
        { hopLabel: "sshServer", host: "db.internal", port: 22, status: "ok" },
      ],
      destination: {
        host: "db.internal",
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
  assert.match(rows[0].textContent, /SSH server/);
  assert.match(rows[0].textContent, /reachable/);
  assert.match(rows[1].textContent, /Destination/);
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
        lookup: async () => ({ resolved: false }), // everything fails to resolve
        test: async () => ({ ok: false, hops: [], destination: null }),
        cancel: async () => ({ ok: true }),
      },
    },
    onSubmit: (payload) => (calls.push(payload), { id: "t1", ...payload }),
  });
  await dlg.openCreate();
  fillValid(dlg);
  await waitUntil(() => destWarn(dlg).hidden === false); // the warning is showing

  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(calls.length, 1, "save proceeds despite the unresolved warning");
});

test("a store __hippoError maps back onto the fields", async () => {
  const dlg = mount({
    onSubmit: () => ({
      __hippoError: true,
      code: "INVALID_DEFINITION",
      errors: { "destination.host": "bad host" },
    }),
  });
  await dlg.openCreate();
  fillValid(dlg);
  dlg.element
    .querySelector("form")
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.ok(
    q(dlg, '.field[data-error-key="destination.host"]').classList.contains(
      "field--error",
    ),
  );
  assert.ok(
    dlg.element.open,
    "the dialog stays open so the error can be fixed",
  );
});
