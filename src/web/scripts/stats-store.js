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

// stats-store.js — the renderer-side data seam for the Feature 30 stats stream.
//
// The main process emits one throttled snapshot of every tunnel over
// `porthippo:stats` (re-dispatched onto `window` as a CustomEvent by preload.js).
// This store is a thin subscriber: it keeps the latest snapshot keyed by tunnel id
// and re-emits a `porthippo:stats-updated` DOM event, so the Feature 50 Monitoring
// view can be a pure subscriber that never touches IPC directly. No rendering and
// no derived math live here — just the data.

class StatsStore {
  #byId = new Map();

  constructor() {
    window.addEventListener("porthippo:stats", (event) =>
      this.#ingest(event.detail),
    );
  }

  /** Replace the snapshot map from a `porthippo:stats` payload and re-broadcast. */
  #ingest(snapshots) {
    if (!Array.isArray(snapshots)) return;
    this.#byId = new Map(snapshots.map((s) => [s.id, s]));
    window.dispatchEvent(
      new CustomEvent("porthippo:stats-updated", {
        detail: { stats: this.#byId },
      }),
    );
  }

  /** Latest snapshot for one tunnel, or null if none has arrived yet. */
  get(id) {
    return this.#byId.get(id) || null;
  }

  /** Latest snapshots for every reported tunnel. */
  all() {
    return [...this.#byId.values()];
  }
}

// A single shared store lives for the renderer's lifetime; importing this module
// activates the subscription. Feature 50 imports `statsStore` to read snapshots.
export const statsStore = new StatsStore();
