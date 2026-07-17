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

// schedule-store.js — the renderer-side data seam for the Feature 150 scheduler.
//
// Main pushes a `porthippo:schedule` snapshot whenever the scheduler re-evaluates
// (re-dispatched onto `window` by preload.js). This store keeps the latest entry
// per tunnel id (its `wanted` / `overridden` state and next time-window
// transition) and re-emits a `porthippo:schedule-updated` DOM event so the tunnel
// views can adorn their rows without touching IPC directly. It primes itself with
// a one-shot pull so the badges are right before the first push arrives. It holds
// only ids + timings — never an SSID, network name, or probe result.

class ScheduleStore {
  #enabled = false;
  #byId = new Map();

  constructor(
    porthippo = typeof window !== "undefined" ? window.porthippo : null,
  ) {
    if (typeof window !== "undefined") {
      window.addEventListener("porthippo:schedule", (event) =>
        this.#ingest(event.detail),
      );
    }
    // Prime from the current status so a row is badged before the first push.
    Promise.resolve(porthippo?.schedule?.status?.())
      .then((status) => this.#ingest(status))
      .catch(() => {});
  }

  #ingest(status) {
    if (!status || typeof status !== "object") return;
    this.#enabled = status.enabled === true;
    const tunnels = Array.isArray(status.tunnels) ? status.tunnels : [];
    this.#byId = new Map(tunnels.map((s) => [s.id, s]));
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("porthippo:schedule-updated", {
          detail: { enabled: this.#enabled, byId: this.#byId },
        }),
      );
    }
  }

  /** Whether scheduling is globally enabled. */
  get enabled() {
    return this.#enabled;
  }

  /** The latest schedule entry for one tunnel, or null if it isn't governed. */
  get(id) {
    return this.#byId.get(id) || null;
  }
}

// A single shared store lives for the renderer's lifetime; importing this module
// activates the subscription (mirrors stats-store.js).
export const scheduleStore = new ScheduleStore();
