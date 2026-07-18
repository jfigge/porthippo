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
 * ipc/dialog.js — native file-dialog IPC.
 *
 * The renderer is sandboxed and can't read a typed filesystem path, so the
 * Definition view's auth editor asks the main process to open a native picker for
 * a private-key file. Only the chosen absolute path crosses back — never file
 * bytes (the engine reads the key itself at connect time, Feature 20).
 *
 * Feature 190 (Mac App Store): the picker requests a security-scoped bookmark for
 * the chosen file (`securityScopedBookmarks: true`). When Electron returns one —
 * only ever on MAS, where the plain user-selected grant would otherwise evaporate
 * on quit — it is persisted immediately (keyed by absolute path), BEFORE the
 * credential is even saved, so access is durable regardless of whether the draft
 * is committed. The handler returns `{ path, remembered }`; `remembered` is true
 * only when a durable bookmark was stored, so the editor can reassure the user.
 * The bookmark blob itself NEVER crosses to the renderer — only the boolean.
 *
 * Every channel registered here MUST have a matching `window.jumphippo.*`
 * exposure in preload.js AND this file must be listed in the ipc-parity test's
 * scan set (tests/ipc-parity.test.js) — the guard fails the build otherwise.
 *
 * @param {object} deps
 * @param {Electron.IpcMain} deps.ipcMain
 * @param {Electron.Dialog} deps.dialog
 * @param {() => Electron.BrowserWindow | null} [deps.getMainWindow]  parent window
 *        for the modal dialog (falls back to a detached dialog when absent).
 * @param {() => { get: (path: string) => (string|null), set: (path: string, bookmark: string) => void }} [deps.getKeyBookmarkStore]
 *        the machine-local security-scoped bookmark store (Feature 190).
 * @param {boolean} [deps.isMas]  true in a Mac App Store build — the only build
 *        where a stored key path needs a bookmark to stay readable (Feature 190).
 */
function registerDialogIPC({
  ipcMain,
  dialog,
  getMainWindow,
  getKeyBookmarkStore,
  isMas = false,
}) {
  ipcMain.handle(
    "dialog:open-key-file",
    async (_event, { defaultPath } = {}) => {
      const parent = getMainWindow?.() ?? undefined;
      const options = {
        title: "Select SSH private key",
        properties: ["openFile", "showHiddenFiles"],
        // Ask macOS to mint an app-scoped bookmark for the chosen file (MAS only;
        // ignored elsewhere → an empty `bookmarks` array). See Feature 190.
        securityScopedBookmarks: true,
        filters: [
          { name: "Private keys", extensions: ["pem", "key", "ppk", "pub"] },
          { name: "All files", extensions: ["*"] },
        ],
      };
      // Open at the currently-selected key's location (pre-selecting the file) when
      // the editor is re-picking an existing path, rather than the panel's default.
      if (typeof defaultPath === "string" && defaultPath.length > 0) {
        options.defaultPath = defaultPath;
      }
      const result = await dialog.showOpenDialog(parent, options);
      if (result.canceled || result.filePaths.length === 0) return null;

      const path = result.filePaths[0];
      // Electron returns a parallel `bookmarks[]` only when it minted one (MAS).
      // Persist it now — before the credential save — keyed by absolute path, so
      // the grant survives a relaunch even if the draft is discarded.
      const bookmark = result.bookmarks?.[0];
      let remembered = false;
      if (bookmark) {
        try {
          getKeyBookmarkStore?.()?.set(path, bookmark);
          remembered = true;
        } catch (err) {
          // A bookmark that can't be stored just degrades to the re-pick flow; the
          // path is still usable this session. Never log the blob itself.
          console.error(
            "[dialog] persisting key bookmark failed:",
            err && err.message,
          );
        }
      }
      return { path, remembered };
    },
  );

  // Feature 190 — re-pick nudge. Report whether a stored key `path` needs to be
  // re-picked to stay usable: true only in a MAS build where the path has no
  // security-scoped bookmark (so a plain read would be denied on the next launch).
  // Off MAS a key path is always readable → never a nudge. `path` is a reference,
  // not a secret; the bookmark blob itself never crosses (only this boolean does).
  ipcMain.handle("dialog:key-status", (_event, { path } = {}) => {
    if (!isMas || typeof path !== "string" || path.length === 0) {
      return { needsRepick: false };
    }
    let hasBookmark = false;
    try {
      hasBookmark = Boolean(getKeyBookmarkStore?.()?.get(path));
    } catch (err) {
      console.error("[dialog] key-status lookup failed:", err && err.message);
    }
    return { needsRepick: !hasBookmark };
  });
}

module.exports = { registerDialogIPC };
