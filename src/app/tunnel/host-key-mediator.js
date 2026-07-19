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
 * host-key-mediator.js — the single owner of SSH host-key trust-on-first-use
 * (TOFU) prompt mediation, shared by the tunnel engine AND the console manager
 * (Feature 200).
 *
 * It builds the per-hop `hostVerifier` (delegating the actual known_hosts /
 * accepted-keys comparison to `makeHostVerifier`) and mediates the unknown-key
 * prompt: when a verifier hits an unknown key it holds the connection pending,
 * this mints a `promptId`, broadcasts `jumphippo:hostkey-unknown`, and resolves
 * once the renderer answers via `trust(promptId)` / `reject(promptId)`. Because
 * ONE mediator instance backs both subsystems, a single `hostkeys:trust/reject`
 * IPC path resolves a prompt raised by either — the TOFU logic exists in exactly
 * one place and can't drift.
 *
 * Prompt ids are globally unique (`crypto.randomUUID`), so a tunnel's and a
 * console's prompts never collide. Only fingerprints ever cross a broadcast —
 * never key material.
 */
"use strict";

const crypto = require("crypto");

const { makeHostVerifier } = require("./host-verifier");

class HostKeyMediator {
  #getStores;
  #knownHostsFile;
  #broadcast;
  #prompts = new Map(); // promptId → { resolve } for pending host-key decisions

  /**
   * @param {object} deps
   * @param {() => import('../store/stores').Stores} deps.getStores
   * @param {string} [deps.knownHostsFile]  override the OpenSSH known_hosts path (tests)
   * @param {(channel: string, payload: object) => void} [deps.broadcast]
   */
  constructor({ getStores, knownHostsFile, broadcast }) {
    this.#getStores = getStores;
    this.#knownHostsFile = knownHostsFile;
    this.#broadcast = broadcast;
  }

  /**
   * Build the ssh2 `hostVerifier` for one hop.
   * @param {{host: string, port: number, hopLabel: string, tunnelId: string}} ctx
   * @returns {(key: Buffer, verify: (ok: boolean) => void) => void}
   */
  buildVerifier(ctx) {
    return makeHostVerifier({
      ...ctx, // host, port, hopLabel, tunnelId
      knownHostsStore: this.#getStores().knownHostsStore(),
      knownHostsFile: this.#knownHostsFile,
      requestTrust: (info) => this.#requestTrust(info),
      reportChanged: (info) =>
        this.#broadcast?.("jumphippo:hostkey-changed", info),
    });
  }

  /** Resolve an unknown-host-key prompt as trusted. */
  trust(promptId) {
    return this.#resolvePrompt(promptId, true);
  }

  /** Resolve an unknown-host-key prompt as rejected. */
  reject(promptId) {
    return this.#resolvePrompt(promptId, false);
  }

  /** Reject every pending prompt (shutdown / lock). */
  rejectAll() {
    for (const { resolve } of this.#prompts.values()) resolve(false);
    this.#prompts.clear();
  }

  #resolvePrompt(promptId, accepted) {
    const prompt = this.#prompts.get(promptId);
    if (!prompt) return { ok: false, promptId };
    this.#prompts.delete(promptId);
    prompt.resolve(accepted);
    return { ok: true, promptId, accepted };
  }

  /** Emit an unknown-host-key prompt and return a promise resolved by the user. */
  #requestTrust(info) {
    const promptId = crypto.randomUUID();
    return new Promise((resolve) => {
      this.#prompts.set(promptId, { resolve });
      this.#broadcast?.("jumphippo:hostkey-unknown", {
        promptId,
        tunnelId: info.tunnelId,
        hop: info.hop,
        host: info.host,
        port: info.port,
        fingerprint: info.fingerprint,
      });
    });
  }
}

module.exports = { HostKeyMediator };
