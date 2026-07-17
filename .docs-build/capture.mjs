// capture.mjs — Drive the Jump Hippo renderer over CDP and capture documentation
// screenshots into docs-originals/images/ (see cdp.mjs IMG_DIR). Each step is
// isolated (try/catch); a failure logs and moves on so one bad step never aborts
// the run.
//
//   node .docs-build/capture.mjs              # run all steps
//   node .docs-build/capture.mjs overview     # run only steps whose name matches
//
// Assumes the app is already running against the seeded ../data-docs dir with the
// CDP port open (see .docs-build/README.md).
import { CDP } from "./cdp.mjs";

const only = process.argv.slice(2);
const cdp = await CDP.connect();
// 1280×800 @2× → 2560×1600 originals; both are valid Mac App Store sizes (16:10).
await cdp.setViewport(1280, 800, 2);
const J = JSON.stringify;

// Seeded tunnel ids (must match seed.mjs).
const TID = (n) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROD = TID(1);
// Every seeded tunnel EXCEPT the remote Webhook relay (tid 7), which connects
// eagerly on arm and would fail DNS on its placeholder host — left disarmed so the
// list shows a realistic mix of Listening (amber) and disarmed (grey) rows.
const ARM_IDS = [1, 2, 3, 4, 5, 6].map(TID);

// ── primitives ────────────────────────────────────────────────────────────────
const clickSel = (sel) =>
  cdp.eval(
    `(()=>{const e=document.querySelector(${J(sel)});if(e){e.click();return true}return false})()`,
  );

// Set a text input's value and fire the events the editor listens on so its
// live validation / preview updates exactly as if the user typed.
const setInput = (sel, value) =>
  cdp.eval(`(()=>{
    const el=document.querySelector(${J(sel)});
    if(!el) return false;
    const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value").set.call(el, ${J(value)});
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);

// Set an input's value WITHOUT firing any events — the text shows but the
// editor's live validation (port-conflict / resolve warnings) never runs, so a
// screenshot stays clean. Used for the illustrative editor shot; we never save.
const setInputRaw = (sel, value) =>
  cdp.eval(`(()=>{
    const el=document.querySelector(${J(sel)});
    if(!el) return false;
    const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value").set.call(el, ${J(value)});
    return true;
  })()`);

// Select a <select>'s option by visible text WITHOUT firing change — shows the
// chosen label without triggering dependent validation.
const selectByTextRaw = (sel, text) =>
  cdp.eval(`(()=>{
    const s=document.querySelector(${J(sel)});
    if(!s) return false;
    const opt=[...s.options].find(o=>o.textContent.includes(${J(text)}));
    if(!opt) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(s, opt.value);
    return true;
  })()`);

// Select the <option> of a <select> whose visible text contains `text`.
const selectByText = (sel, text) =>
  cdp.eval(`(()=>{
    const s=document.querySelector(${J(sel)});
    if(!s) return false;
    const opt=[...s.options].find(o=>o.textContent.includes(${J(text)}));
    if(!opt) return false;
    const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set;
    set.call(s, opt.value);
    s.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  })()`);

const winEvent = (name, detail) =>
  cdp.eval(
    `window.dispatchEvent(new CustomEvent(${J(name)}${detail ? `,{detail:${J(detail)}}` : ""}))`,
  );

const setMode = async (mode) => {
  await cdp.eval(`window.jumphippo.settings.set({detailMode:${J(mode)}})`);
  await winEvent("jumphippo:set-detail-mode", { mode });
};

async function dispatchKey(key, code, vk, modifiers = 0) {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers,
    });
  }
}
const escape = () => dispatchKey("Escape", "Escape", 27);

// Clear any transient popup notifications so they don't photobomb a shot.
const clearToasts = () =>
  cdp.eval(
    `document.querySelectorAll('[class*="notification"],[class*="toast"]').forEach(e=>e.remove())`,
  );
async function shot(name) {
  await clearToasts();
  await cdp.shot(name);
}

// Close whatever native <dialog> is open (editor / resolve popup).
async function closeDialog() {
  await clickSel(".dialog-cancel");
  await escape();
  await cdp.sleep(250);
}

// ── one-time setup ────────────────────────────────────────────────────────────
// Arm the listening set so the sidebar/table show live amber status lamps, then
// select Prod database and settle on the cards presentation.
async function setup() {
  await setMode("cards");
  for (const id of ARM_IDS) {
    try {
      await cdp.eval(`window.jumphippo.tunnels.arm(${J(id)})`);
    } catch {
      /* best-effort */
    }
  }
  await cdp.sleep(1000);
  await clickSel(`.tunnel-row[data-id="${PROD}"]`);
  await cdp.sleep(400);
}

// ── steps ─────────────────────────────────────────────────────────────────────
const steps = [];
const step = (name, fn) => steps.push({ name, fn });

step("overview", async () => {
  await setMode("cards");
  await clickSel(`.tunnel-row[data-id="${PROD}"]`);
  await cdp.sleep(400);
  await shot("overview");
});

step("list-view", async () => {
  await setMode("list");
  await cdp.sleep(600);
  await shot("list-view");
  await setMode("cards");
  await cdp.sleep(300);
});

step("tunnel-editor", async () => {
  await winEvent("jumphippo:new-tunnel");
  await cdp.sleep(500);
  // Value-only (no events) so the illustrative fields show without triggering the
  // demo-environment warnings (no DNS; the seeded Prod database owns port 5432).
  await setInputRaw(".editor-input-name", "Prod database");
  await setInputRaw(".editor-input-entryAddress", "5432");
  await setInputRaw(".editor-input-targetServer", "bastion.example.com");
  await setInputRaw(".editor-input-exitAddress", "db.internal:5432");
  await selectByTextRaw(".cred-picker-select", "deploy");
  await cdp.sleep(400);
  await shot("tunnel-editor");
  await closeDialog();
});

step("tunnel-editor-config", async () => {
  await winEvent("jumphippo:new-tunnel");
  await cdp.sleep(400);
  await setInput(".editor-input-name", "Prod database");
  await setInput(".editor-input-entryAddress", "5432");
  await setInput(".editor-input-targetServer", "bastion.example.com");
  await clickSel('.dialog-tab[data-tab="config"]');
  await cdp.sleep(400);
  await shot("tunnel-editor-config");
  await closeDialog();
});

step("settings", async () => {
  await winEvent("jumphippo:open-settings");
  await cdp.sleep(500);
  await shot("settings");
  await escape();
  await cdp.sleep(300);
});

step("settings-security", async () => {
  await winEvent("jumphippo:open-settings");
  await cdp.sleep(400);
  await clickSel('.settings-nav-item[data-panel="security"]');
  await cdp.sleep(500);
  await shot("settings-security");
  await escape();
  await cdp.sleep(300);
});

// ── run ───────────────────────────────────────────────────────────────────────
await setup();
const selected = steps.filter(
  (s) => only.length === 0 || only.some((o) => s.name.includes(o)),
);
console.log(`Running ${selected.length} step(s)...`);
for (const s of selected) {
  try {
    await s.fn();
    console.log(`  ✓ ${s.name}`);
  } catch (e) {
    console.log(`  ✗ ${s.name}: ${e.message}`);
  }
}
cdp.close();
console.log("done");
