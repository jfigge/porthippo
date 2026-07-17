# docs-build — screenshot tooling

Reproducible pipeline that generates the screenshots embedded in the user guide
(`src/web/docs/`). It seeds a clean, **secret-free** demo workspace, drives the
running app over the Chrome DevTools Protocol, and writes full-res PNGs into the
gitignored `docs-originals/images/`. A downscale step then derives the 50% copies
that are actually bundled under `src/web/docs/images/`.

The whole thing mirrors Rest Hippo's `.docs-build/` (see `../resthippo`).

## Regenerating the screenshots

```bash
# 1. Seed the demo tunnels + settings into a DEDICATED data dir (./data-docs) so
#    the real dev data dir (./data) is never touched.
node .docs-build/seed.mjs

# 2. Launch the app with the CDP port open, pointed at the seeded data dir. Use a
#    separate --user-data-dir so this never collides with a running `make debug`
#    (Electron's single-instance lock is per-user-data-dir).
( cd src && npx electron app/main.js \
    --user-data-dir="$PWD/../data-docs" --remote-debugging-port=9222 ) &

# 3. Capture (all steps, or pass name substrings to capture a subset).
node .docs-build/capture.mjs
node .docs-build/capture.mjs tunnel-editor settings

# 4. Derive the bundled 50% copies that ship under src/web/docs/images.
for f in docs-originals/images/*.png; do
  cp "$f" "src/web/docs/images/$(basename "$f")"
  w=$(sips -g pixelWidth "src/web/docs/images/$(basename "$f")" | awk '/pixelWidth/{print $2}')
  sips --resampleWidth $((w / 2)) "src/web/docs/images/$(basename "$f")" >/dev/null
done
```

## Files

- `seed.mjs` — writes the single definitions document (`tunnels.json`) — a handful
  of demo tunnels (local / dynamic / remote) across two groups, plus reusable
  credentials and one jump host — and `settings.json`. Deterministic UUIDs, no real
  secrets: every credential uses `agent` or `key` auth, so nothing is ever
  encrypted and the app boots in the promptless device-app-key mode.
- `cdp.mjs` — a minimal CDP client (connect, `eval`, `shot`, mouse/key input).
- `capture.mjs` — one step per screenshot; each step is isolated, so a failure
  logs and the run continues. Pass step-name substrings as args to run a subset.

## Notes / limitations

- Uses the **dark** theme and a fixed **1280×800** viewport captured at 2× →
  **2560×1600** originals; the bundled 50% copies are exactly **1280×800**. Both
  sizes are valid **Mac App Store** screenshot dimensions (16:10), so the same
  captures serve the guide and a store listing. Keep these fixed so the guide stays
  visually consistent across re-captures.
- `settings.armOnLaunch` is seeded **false** so launching binds no local listeners.
  `capture.mjs` then arms the tunnels it wants shown as **Listening** (amber) — this
  only binds the local port; it never opens a real SSH connection (the demo hosts
  are placeholders that don't resolve). The **remote** Webhook relay is left
  disarmed because a remote tunnel connects eagerly on arm.
- The **illustrative editor** shot fills its fields value-only (no input events) so
  the demo-environment soft warnings (no DNS; the seeded Prod database already owns
  port 5432) don't fire. We never save that draft.
- The **row / group right-click context menus** and **native file pickers**
  (Import/Export, key browse) render as real OS menus/dialogs *outside* the web
  contents, which `Page.captureScreenshot` cannot capture — those features are
  documented in prose instead. Everything else (the tunnel/credential/group
  editors, Settings, About) is an HTML `<dialog>`/popup inside the web contents and
  captures fine.
- The renderer reads through the main-process store over IPC, which holds the store
  in memory — so after re-seeding, **restart the app** (or dispatch
  `jumphippo:data-imported`) rather than relying on a renderer reload.
