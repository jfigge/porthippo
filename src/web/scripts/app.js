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

// app.js — renderer bootstrap for the Feature 00 shell. Wires the
// Definition / Monitoring / Split view toggle and shows the app version fetched
// over the window.porthippo IPC bridge. Later features mount real components
// into #definition-view and #monitoring-view.

// Activate the Feature 30 stats seam: importing it for its side effect starts the
// `porthippo:stats` subscription so the latest per-tunnel snapshots are captured
// from load, ready for the Feature 50 Monitoring view to render.
import "./stats-store.js";

const VIEWS = ["definition", "monitoring", "split"];

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
    if (VIEWS.includes(view)) applyView(view);
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
  applyView("definition");
  initVersion();
});
