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

// app.js — renderer bootstrap. Wires the Definition / Monitoring / Split view
// toggle (persisting the choice in settings), mounts the Feature 40 Definition
// view, installs the app-wide SSH host-key trust prompt, and shows the app
// version fetched over window.porthippo. The Monitoring pane is filled in by
// Feature 50.

// Activate the Feature 30 stats seam: importing it for its side effect starts the
// `porthippo:stats` subscription so the latest per-tunnel snapshots are captured
// from load, ready for the Feature 50 Monitoring view to render.
import "./stats-store.js";

import { DefinitionView } from "./components/definition-view.js";
import { MonitoringView } from "./components/monitoring-view.js";
import { HostKeyPrompt } from "./host-key-prompt.js";

const VIEWS = ["definition", "monitoring", "split"];

// The two panes are each mounted once and kept alive across view switches — so
// the Monitoring view holds a single `porthippo:stats` subscription whether it is
// shown alone or side-by-side in split mode. `applyView` only toggles visibility.
let definitionView = null;
let monitoringView = null;

function applyView(view) {
  const content = document.getElementById("app-content");
  const definition = document.getElementById("definition-view");
  const monitoring = document.getElementById("monitoring-view");
  if (!content || !definition || !monitoring) return;

  content.dataset.view = view;

  // In split mode both panes are visible; otherwise show only the active one.
  definition.hidden = view === "monitoring";
  monitoring.hidden = view === "definition";

  for (const btn of document.querySelectorAll(".view-toggle-btn")) {
    btn.classList.toggle("view-toggle-btn--active", btn.dataset.view === view);
    btn.setAttribute("aria-selected", String(btn.dataset.view === view));
  }

  // App-wide notification so later panes can react (e.g. start/stop live
  // subscriptions when they become visible).
  window.dispatchEvent(
    new CustomEvent("porthippo:view-changed", { detail: { view } }),
  );
}

function initViewToggle() {
  const toggle = document.getElementById("view-toggle");
  if (!toggle) return;
  toggle.addEventListener("click", (event) => {
    const btn = event.target.closest(".view-toggle-btn");
    if (!btn) return;
    const view = btn.dataset.view;
    if (!VIEWS.includes(view)) return;
    applyView(view);
    // Persist the choice; non-fatal if the write fails.
    window.porthippo?.settings?.set?.({ viewMode: view })?.catch?.(() => {});
  });
}

async function initView() {
  // Restore the persisted view mode before the first paint of the panes.
  let view = "definition";
  try {
    const settings = await window.porthippo?.settings?.get?.();
    if (settings && VIEWS.includes(settings.viewMode)) view = settings.viewMode;
  } catch {
    // Non-fatal: fall back to the default view.
  }
  applyView(view);
}

async function initDefinitionView() {
  const host = document.getElementById("definition-view");
  if (!host) return;
  definitionView = new DefinitionView();
  host.appendChild(definitionView.element);
  try {
    await definitionView.load();
  } catch (err) {
    console.error("[app] definition view load failed:", err && err.message);
  }
}

async function initMonitoringView() {
  const host = document.getElementById("monitoring-view");
  if (!host) return;
  monitoringView = new MonitoringView();
  host.appendChild(monitoringView.element);
  try {
    await monitoringView.load();
  } catch (err) {
    console.error("[app] monitoring view load failed:", err && err.message);
  }
}

// A row's "Edit" affordance in the Monitoring view asks the shell to jump to the
// Definition view for that tunnel. Stay put when already showing Definition (or
// split); only flip away from the monitoring-only view.
function initEditTunnelBridge() {
  window.addEventListener("porthippo:edit-tunnel", (event) => {
    const id = event.detail && event.detail.id;
    if (!id) return;
    const content = document.getElementById("app-content");
    if (content && content.dataset.view === "monitoring") {
      applyView("definition");
      window.porthippo?.settings
        ?.set?.({ viewMode: "definition" })
        ?.catch?.(() => {});
    }
    definitionView?.selectById(id);
  });
}

async function initVersion() {
  const el = document.getElementById("app-version");
  if (!el || !window.porthippo) return;
  try {
    const version = await window.porthippo.getVersion();
    el.textContent = `v${version} · ${window.porthippo.platform}/${window.porthippo.arch}`;
  } catch {
    // Non-fatal: the version label is informational only.
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initViewToggle();
  initView();
  new HostKeyPrompt().install();
  initEditTunnelBridge();
  initDefinitionView();
  initMonitoringView();
  initVersion();
});
