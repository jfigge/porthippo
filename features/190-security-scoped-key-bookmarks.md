# Feature 190 — Security-scoped bookmarks for key files (MAS)

## Context

Depends on: **20** (SSH engine + injectable `readFileSync` on `Tunnel`/`ssh-chain`), **90**
(credential store), **60**/store-gating (`store-build.js` `isMas()`). Companion to the MAS
sandbox work in `STORE-PUBLISHING.md`.

In the **Mac App Store** build Jump Hippo runs under the App Sandbox with only
`com.apple.security.files.user-selected.read-only`. That grant is **per-session**: when the
user picks a private key through the native open panel (`ipc/dialog.js` →
`dialog:open-key-file`), the app may read that file *now*, but the grant evaporates on quit.
The credential store only persists the **path** (e.g. `/Users/jason/.ssh/id_rsa`), so on the
next launch `ssh-chain.js` `buildAuthHandler` calls `readFileSync(entry.privateKeyPath)`, the
sandbox denies it (`EACCES`), that auth method is silently dropped, and the tunnel can't
authenticate — with no obvious reason (it worked yesterday). This is the last unmitigated MAS
functional caveat: **key-file paths don't survive a relaunch.**

The fix Apple provides is **security-scoped bookmarks**: at pick time the app mints an
app-scoped bookmark blob for the chosen URL and persists it; on later launches it resolves the
bookmark and brackets the file read with start/stop-accessing calls to re-enter the sandbox
for exactly that file. Electron exposes this via `dialog.showOpenDialog({ securityScopedBookmarks:
true })` (returns a parallel `bookmarks[]`) and `app.startAccessingSecurityScopedResource(bookmark)`
(returns a stop function). Both are macOS-**mas**-only.

## Goal

In the MAS build, a private key the user picks **stays readable across relaunches** without
re-picking, by persisting an app-scoped security bookmark per key path and bracketing every
key read with start/stop-accessing. Everywhere else (direct macOS, Windows, Linux) behaviour is
unchanged — a plain `fs.readFileSync`. A stale/missing bookmark degrades to exactly today's
"re-pick the key" flow, never a crash, and the engine stays **Electron-free** (the scoped
reader is injected from main).

## Design decisions (settled — do not relitigate)

- **MAS-only, gated on `isMas()`; no-op everywhere else.** The bookmark store and the scoped
  reader exist in all builds but only *do* anything under `process.mas`. The new entitlement
  (`com.apple.security.files.bookmarks.app-scope`) is added **only** to
  `packaging/entitlements.mas.plist`. Direct/Win/Linux read keys with a plain `fs.readFileSync`,
  as today.
- **The bookmark is captured at pick time, in main, keyed by absolute path.** `dialog:open-key-file`
  passes `securityScopedBookmarks: true` and, when Electron returns a bookmark, immediately
  persists `{ [absolutePath]: bookmarkBase64 }` via a new `KeyBookmarkStore` — *before* the
  credential is even saved — so access is durable regardless of whether the draft is committed.
  Keying by path (not credential id) is intentional: two credentials pointing at the same key
  share one grant, and re-picking the same path refreshes it.
- **A new main-side `secure-file.js` owns the Electron `app` access; the engine gets an injected
  reader.** `secure-file.js` exports `makeKeyReader({ app, bookmarks, isMas })` → a
  `readFileSync`-shaped `(path) => Buffer`. On MAS it looks up the bookmark, calls
  `const stop = app.startAccessingSecurityScopedResource(bookmark)`, reads inside a
  `try/finally` that always `stop()`s, and returns the bytes; with no/stale bookmark it evicts
  the entry and falls back to a plain read (which throws in the sandbox → the method is dropped
  as today). Off MAS it *is* plain `fs.readFileSync`. `main.js` injects this as a new
  `keyReader` option on `TunnelEngine`, threaded through `#makeTunnel` → `Tunnel` deps
  `readFileSync` → `ssh-chain buildAuthHandler`. **The engine never imports Electron** — same
  seam the tests already use to inject a fake `readFileSync`.
- **Bookmarks are machine-local and are NEVER exported.** They live in their own
  `key-bookmarks.json` under `userData` (new `paths.keyBookmarksPath()`), not in `tunnels.json`
  and not in the `.jumphippo` bundle (Feature 120 already carries only the reference `keyPath`,
  never machine-scoped access blobs — mirrors how a device-key sealed secret is never exported).
  The blob is an OS access token to a path, not a secret value, but it is treated as
  non-portable and is redaction-irrelevant (never logged).
- **The IPC return shape becomes an object.** `dialog:open-key-file` returns
  `{ path, remembered }` (was a bare string) — `remembered` is `true` when a durable bookmark
  was stored (MAS), so the credential editor can reassure the user ("this key will be
  remembered") vs. the direct build where the concept doesn't apply. `preload.js` and
  `credential-editor-dialog.js` update together; the channel name is unchanged so the
  `ipc-parity` guard stays green.
- **Stale bookmarks self-heal.** Resolution/`startAccessing` failure (file moved, deleted,
  bookmark invalidated) deletes the entry and falls through to the plain read; the connect fails
  the same way it does today and the user re-picks, which re-mints a fresh bookmark. No stale
  entry is ever retried forever.

## Implementation steps

1. **Entitlement.** Add `com.apple.security.files.bookmarks.app-scope` (`true`) to
   `packaging/entitlements.mas.plist`; note it in the file's header comment and in
   `STORE-PUBLISHING.md` (the "Key-file paths don't survive a relaunch" caveat becomes "fixed by
   Feature 190").
2. **`store/paths.js`.** Add `keyBookmarksPath()` → `key-bookmarks.json`; document it in the
   layout header.
3. **`store/key-bookmark-store.js`** (new). A tiny store over `io.readJSON`/`writeJSON`:
   `get(path)`, `set(path, bookmark)`, `delete(path)`, `list()`. Shape
   `{ bookmarks: { "<absPath>": "<base64>" } }`. Corrupt-tolerant (io quarantines). Wire it into
   `store/stores.js` as `keyBookmarkStore()`.
4. **`ipc/dialog.js`.** Pass `securityScopedBookmarks: true`; on a non-cancelled pick, if
   `result.bookmarks?.[0]` is present persist it via `keyBookmarkStore().set(path, bookmark)` and
   return `{ path, remembered: true }`, else `{ path, remembered: false }`. Inject the store via
   the handler deps (keep it testable — no direct `require`).
5. **`app/secure-file.js`** (new). `makeKeyReader({ app, getBookmark, deleteBookmark, isMas })`
   returning `(filePath) => Buffer`. MAS path: bookmark lookup → `startAccessingSecurityScopedResource`
   → `fs.readFileSync` in `try`, `stop()` in `finally`; on any failure evict + rethrow/fallback.
   Non-MAS: `fs.readFileSync(filePath)`.
6. **Engine injection.** Add a `keyReader` option to `TunnelEngine`; default `fs.readFileSync`
   (tests unaffected). Pass it through `#makeTunnel` into the `Tunnel` deps as `readFileSync`.
   In `main.js`, build the reader with `makeKeyReader({ app, ... , isMas: isMas() })` (import
   `isMas` from `store-build.js`) and pass it to `new TunnelEngine({ …, keyReader })`.
7. **Renderer.** Update `preload.js` `dialog.openKeyFile` to return the object; update
   `credential-editor-dialog.js` to read `.path` and, when `.remembered`, show a small
   "remembered for this Mac" hint (i18n key). Keep the direct-build wording neutral.
8. **i18n.** Add the hint key to `EN` in `i18n.js`, regenerate `en.json` (the byte-identical
   test), and add the key to the six translated catalogs (parity test — Feature 180).
9. **Tests.**
   - `key-bookmark-store.test.js`: set/get/delete/list, corrupt-file tolerance.
   - `secure-file.test.js`: MAS reader brackets the read with a fake `app` (start returns a
     stop spy; assert stop always called, even on read throw); stale bookmark evicts + falls
     back; non-MAS reader is a plain read that never touches `app`.
   - `dialog.js` test: bookmark captured + `remembered:true`; no-bookmark path returns
     `remembered:false`; still returns the path.
   - Extend the `ipc-parity` scan set if any new `ipc/*.js` is added (none expected — reuse
     `dialog.js`).

## Acceptance criteria

- In a **MAS** build: pick a key, quit, relaunch, and a tunnel using that key **connects without
  re-picking** the file. (Manual: `make mas-dev`, sandbox container, verify.)
- A moved/deleted key (stale bookmark) fails to connect the same way as today and re-picking it
  restores access; no crash, no infinite retry of a dead bookmark.
- Direct macOS / Windows / Linux builds are byte-for-byte unchanged in behaviour — plain key
  reads, no bookmark files written, `app.startAccessingSecurityScopedResource` never called.
- The engine still imports no Electron; the scoped reader is injected. `key-bookmarks.json` is
  never included in a `.jumphippo` export and never appears in logs/diagnostics.
- `make fmt && make lint && make test` green; the new entitlement is present only in the MAS
  plist.

## Constraints

- MAS-only behaviour, gated on `isMas()`; the new entitlement lives only in
  `entitlements.mas.plist`.
- Persistence/scoped-access/Electron stay in main; the engine remains Electron-free via the
  injected `keyReader` (the existing `readFileSync` seam).
- Every `startAccessingSecurityScopedResource` is paired with its stop function in a `finally`
  — never leak a scoped-resource grant.
- Bookmarks are machine-local: never exported, never logged, never placed in `tunnels.json`.
- Renderer only picks and displays; it never receives file bytes or a bookmark blob.

## Verify

```
make fmt && make lint && make test
make mas-dev   # install the .pkg (or run the dev build), pick a real private key for a
               # key-auth credential, connect a tunnel through it, then QUIT and RELAUNCH.
               # Access the local port again and confirm the tunnel authenticates with NO
               # re-pick. Move the key aside → confirm a clean auth failure + that re-picking
               # restores it. Confirm key-bookmarks.json exists in the container userData and
               # is absent from a `.jumphippo` export.
make debug     # direct build: confirm key auth still works with no bookmark file written.
```
