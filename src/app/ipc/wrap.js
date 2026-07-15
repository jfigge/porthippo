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

// ipc/wrap.js — the shared async IPC handler wrapper for the request/response
// engine + resolve channels. It awaits the handler, normalizes an `undefined`
// result to `null` (so the value stays serializable across IPC), and turns a
// thrown error into the same discriminable `{ __hippoError }` envelope the store
// IPC surfaces — the renderer reads that instead of a rejected invoke. Factored out
// of ipc/engine.js and ipc/resolve.js (which held byte-identical copies) so the two
// can't drift. (The store/secret-storage handlers use the synchronous
// safeCall/safeCallWrite injected from main.js; this is their async sibling.)
"use strict";

/**
 * Wrap an async IPC handler. Each call site passes `channel` as a string LITERAL so
 * the ipc-parity guard can see every registered channel.
 *
 * @param {string} channel  the IPC channel name (for error logging + the envelope)
 * @param {(...args: any[]) => any} fn  the handler; receives the invoke arguments
 * @returns {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any>}
 */
function wrap(channel, fn) {
  return async (_event, ...args) => {
    try {
      const result = await fn(...args);
      return result === undefined ? null : result;
    } catch (err) {
      console.error(`[main] ${channel} error:`, err && err.message);
      return {
        __hippoError: true,
        channel,
        message: err && err.message,
        code: err && err.code,
      };
    }
  };
}

module.exports = { wrap };
