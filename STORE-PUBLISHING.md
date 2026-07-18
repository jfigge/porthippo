# Publishing Jump Hippo to the Mac App Store & Microsoft Store

This is the maintainer walkthrough for building and submitting the **store**
editions of Jump Hippo. The direct GitHub-release builds (DMG/ZIP, NSIS/portable
EXE, AppImage/deb) are unchanged and documented elsewhere — this covers only the
two app stores.

## How it works (one codebase, one flag)

Jump Hippo ships a **single codebase** to every channel. Electron sets a global
in each store build — `process.mas` (Mac App Store) and `process.windowsStore`
(Microsoft Store) — and `src/app/store-build.js` exposes that as
`isStoreBuild()`, `isMas()`, and `isAppx()`. Features that can't run in a store
build gate on those helpers at runtime instead of being compiled out:

| Disabled in… | Feature | Why |
| --- | --- | --- |
| Both stores | In-app self-updater + "Check for Updates…" menu item | The store delivers updates; there is no update feed. |
| Both stores | **Launch at login** (Settings → Behaviour) | The store login-item mechanisms aren't what Electron's `setLoginItemSettings` drives. The row is shown disabled with a hint; `applyLoginItem` also refuses to apply it. |
| MAS only | **SSH-agent auth** (credential editor) | `SSH_AUTH_SOCK` is outside the App Sandbox. The "SSH agent" auth option is hidden; an existing agent credential still opens, with a warning to switch to a key/password. (Works on the full-trust Microsoft Store build.) |
| MAS only | **"Import from SSH config" default path** | The sandbox can't read `~/.ssh` from its own `$HOME`, so the import can't default to it — a note tells the user to pick the file manually via the open panel. |

Gating is data-driven: `src/app/store-build.js` `capabilities()` derives the map
from `process.mas` / `process.windowsStore`, and it's handed to the sandboxed
renderer over IPC (`app:capabilities` → `window.jumphippo.build` →
`web/scripts/build-info.js`), which the UI reads via `can(feature)`. The map
**fails open** — a broken bridge never hides a feature in a direct build.

### MAS functional caveats (App Sandbox)

The MAS build runs under Apple's App Sandbox
(`src/packaging/entitlements.mas.plist`), which constrains an SSH tunnel
manager more than a typical app. The gated features above surface an in-UI
explanation; the remaining caveats degrade gracefully:

- **`~/.ssh/known_hosts` is read from the real home** — the sandbox redirects
  `$HOME` to the container, so a naïve `os.homedir()` lookup lands on a dead
  `…/Containers/…/Data/.ssh` path. Jump Hippo instead resolves the **real** home
  via `getpwuid` (`os.userInfo().homedir`, which ignores the redirected `$HOME`)
  and reads the actual `~/.ssh/known_hosts`, granted by a **read-only
  home-relative-path temporary exception** scoped to that single file
  (`entitlements.mas.plist`). So host-key verification matches the same hosts the
  system `ssh` already trusts, and the Host Keys → "Operating System" tab shows a
  real inventory (not an empty container path). Jump Hippo's own accepted-keys
  store + TOFU prompts still apply on top. **App Store review note:**
  temporary-exception entitlements require a justification in the App Review notes
  and can be challenged; the grant is deliberately the single `known_hosts` file
  (never the whole `~/.ssh`, so private keys are never exposed) to keep the ask
  minimal and defensible. Verify the read actually works on-device with a
  `make mas-dev` build (below).
- **ssh-agent auth doesn't work** — the agent's socket (`SSH_AUTH_SOCK`) is
  outside the sandbox. The agent auth option is now **gated out** of the MAS
  build (see the table above); use key-file or password credentials.
- **Key-file paths survive a relaunch (Feature 190)** — the open dialog
  (`files.user-selected.read-only`) grants access only for the session, so on
  its own the stored path can't be re-read after a quit. Jump Hippo now mints an
  app-scoped **security-scoped bookmark** at pick time
  (`files.bookmarks.app-scope`, stored machine-locally in `key-bookmarks.json`,
  never exported) and brackets every key read with start/stop-accessing, so a
  key-auth tunnel authenticates on the next launch with no re-pick. A
  moved/deleted key (stale bookmark) degrades to the old "re-pick the key" flow
  — a clean auth failure, never a crash — and re-picking re-mints the bookmark.
- **Local-network hosts need permission (macOS 15+)** — a jump host or
  destination on the LAN (`10.x`, `172.16–31.x`, `192.168.x`) triggers macOS's
  Local Network privacy gate. The connection is refused *before* the SSH
  handshake — so no host-key prompt appears and it looks like a host-key
  problem, not a permission one. The `mac`/`mas` builds now declare
  `NSLocalNetworkUsageDescription` (in `package.json` → `build.mac/mas.extendInfo`)
  so macOS shows a proper prompt; the user must approve it (Settings → Privacy &
  Security → Local Network). Purely public / non-LAN hosts are unaffected.

Local listeners keep working (`network.server` is entitled), as do outbound SSH
connections (`network.client`) and everything stored in `userData` (definitions,
encrypted secrets, accepted keys, logs). Note the log path is resolved *after*
`app.whenReady()` (a lazy dir thunk in `logger.js`) — resolving it at module-load
lands it outside the sandbox container, where every write is silently denied.

The build targets and CI jobs **graceful-skip** until you supply the external
accounts and certificates, so all of this is already in the repo and nothing
fails before you're ready (see "Verify without accounts" at the end).

---

## Mac App Store

You have an Apple Developer Program membership (the certs are shared with Rest
Hippo — Apple certificates are **team-level**, not per-app). You still need a
Jump-Hippo-specific App Store Connect app record and provisioning profile.

### 1. App Store Connect record

1. Go to <https://appstoreconnect.apple.com> → **Apps** → **+** → **New App**.
2. Platform **macOS**, pick the name, primary language, and the bundle ID
   **`com.jumphippo.app`** (matches `build.appId` in `src/package.json`). Set an
   SKU.
3. Fill in the listing later — you can create the record now and submit a build
   afterward.

### 2. Register the App ID with App Sandbox

1. <https://developer.apple.com/account> → **Certificates, Identifiers &
   Profiles** → **Identifiers**.
2. Find/create the App ID `com.jumphippo.app`. It needs the **App Sandbox**
   capability (App Store apps are always sandboxed — our
   `entitlements.mas.plist` declares it, plus incoming/outgoing network).

### 3. Certificates (already exist — shared with Rest Hippo)

The **Apple Distribution** and **Mac Installer Distribution** identities in the
login keychain sign every app on the team, so nothing new is needed here. Local
backups live in `.keys/` (`MAS_Application.p12`, `MAS_Installer.p12`,
git-ignored). If the private keys are ever lost, follow Rest Hippo's
`REPLACE-KEYS.md` runbook — it applies verbatim apart from the profile name.

> These are *distinct* from the **Developer ID Application** cert used for the
> direct (non-store) DMG. A machine can hold all three.

### 4. Provisioning profiles (Jump-Hippo-specific — must be created)

Developer portal → **Profiles** → **+**:

- A **Mac App Store** *distribution* profile for `com.jumphippo.app`, tied to
  the Apple Distribution cert. Download it and save it as:
  ```
  src/packaging/embedded.provisionprofile
  ```
- (Optional, for local sandbox testing) a **Mac App Store** *development*
  profile → save as `src/packaging/development.provisionprofile`.

Both paths are **git-ignored** (`*.provisionprofile`) — never commit them.

### 5. Build & test locally

```bash
make mas-dev     # builds a development-signed sandbox build you can run locally
                 # to smoke-test the sandbox (skips if no development profile)
make dist-mas    # builds the distribution .pkg for submission
                 # (skips if no embedded.provisionprofile)
```

Run the `mas-dev` build first and exercise the app — arm a tunnel, confirm the
listener binds and the SSH chain connects, exercise a key-file credential and a
password credential, and confirm the MAS caveats above degrade cleanly. The
output `.pkg` lands in `build/src/dist/`.

### 6. Upload & submit

Upload the `.pkg` with **Transporter** (free on the Mac App Store) or
`xcrun altool --upload-app`, then in App Store Connect attach the build to a
version and submit for review.

---

## Microsoft Store (MSIX / appx)

You have a Microsoft developer account (shared with Rest Hippo). The Store
**re-signs** the package on upload, so you do **not** need a code-signing
certificate — you only need a reserved app identity for Jump Hippo.

### 1. Partner Center registration

1. <https://partner.microsoft.com/dashboard> → **Apps and games** →
   **+ New product** → **App** → reserve the app name (e.g. "Jump Hippo").

### 2. Copy the product identity

In Partner Center → your app → **Product management** → **Product identity**.
Copy these three values into either `src/package.json` (`build.appx`) or
`release.env` (the `APPX_*` vars the Makefile reads):

| Partner Center field | `build.appx` key | `release.env` var |
| --- | --- | --- |
| Package/Identity/Name | `identityName` | `APPX_IDENTITY_NAME` |
| Package/Identity/Publisher | `publisher` (`CN=…`) | `APPX_PUBLISHER` |
| Publisher display name | `publisherDisplayName` | `APPX_PUBLISHER_DISPLAY_NAME` |

The committed `build.appx` currently holds `FILL-LATER-…` placeholders — replace
them, or leave them and pass the real values via `release.env`/CI (the
`make dist-appx` CLI overrides win).

### 3. Build (on Windows)

```bash
make dist-appx   # builds the .appx (skips if APPX_IDENTITY_NAME/APPX_PUBLISHER unset)
```

The `.appx` lands in `build/src/dist/`.

### 4. Upload & submit

Partner Center → your app → **Submissions** → **Packages** → upload the
`.appx`, complete the listing, and submit for certification.

---

## CI (GitHub Actions)

`.github/workflows/release.yml` has two extra jobs, `store-mas` and
`store-appx`, that build the store packages on tag pushes / manual dispatch and
upload them as the `store-mas` / `store-appx` artifacts. They are **not**
attached to the public GitHub Release (that only globs `installers-*`);
download them from the run and submit manually. Each job is gated so it is a
**clean no-op** until you set its variable:

| Job | Enable with | Plus these secrets |
| --- | --- | --- |
| `store-mas` | `vars.MAS_ENABLED = 'true'` | `MAS_CSC_LINK`, `MAS_CSC_KEY_PASSWORD`, `MAS_INSTALLER_CSC_LINK`, `MAS_INSTALLER_CSC_KEY_PASSWORD`, `MAS_PROVISIONING_PROFILE_BASE64` |
| `store-appx` | `vars.APPX_IDENTITY_NAME != ''` | also `vars.APPX_PUBLISHER`, `vars.APPX_PUBLISHER_DISPLAY_NAME` |

Encode the macOS material as base64 (`base64 -i .keys/MAS_Application.p12 |
pbcopy`, `base64 -i src/packaging/embedded.provisionprofile | pbcopy`) and
paste into **Settings → Secrets and variables → Actions** (or use `gh secret
set`).

### Auto-submit on release (the push to the store) + the kill-switch

The store jobs always **build** the package (so you can confirm CI packaging
works, and the `.pkg`/`.appx` is kept as a run artifact). The actual **push to
the store** is a separate step that runs only when **both** are true:

1. the workflow was triggered by a **tag release** (`v*`) — never on a manual
   `workflow_dispatch` smoke-test, and `release.yml` doesn't run on branch
   pushes at all; and
2. the kill-switch variable **`vars.STORE_SUBMIT_ENABLED == 'true'`**.

So the rollout is: wire up the cert secrets + `MAS_ENABLED` now and **leave
`STORE_SUBMIT_ENABLED` unset** → every tagged release builds + archives the
package but does **not** submit. Once the first release is **approved**, set
`STORE_SUBMIT_ENABLED = true` and future releases auto-upload. Flip it back off
any time to pause submissions.

The upload only makes the build **appear in App Store Connect** (processed,
ready) — the final **Submit for Review** stays a deliberate manual click in the
ASC web UI, so CI never ships to users on its own. (The Microsoft Store step
likewise publishes with `--noCommit`, leaving a draft submission.)

Auto-submit auth (add when you flip the switch on):

| Store | Variable to enable | Submit secrets |
| --- | --- | --- |
| App Store Connect | `vars.STORE_SUBMIT_ENABLED = 'true'` | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY_BASE64` (base64 of `AuthKey_<id>.p8` — backups in `.keys/`) |
| Microsoft Store | same | `MS_STORE_TENANT_ID`, `MS_STORE_CLIENT_ID`, `MS_STORE_CLIENT_SECRET`, `vars.MS_STORE_PRODUCT_ID` (Partner Center Azure-AD app — set up when Partner Center exists) |

Get the **Issuer ID** from App Store Connect → **Users and Access →
Integrations → App Store Connect API** (a copy lives in `.keys/issuer_Id`).

---

## Verify without accounts

Everything graceful-skips, so you can confirm the wiring before any account
exists:

```bash
make dist-mas    # → "No MAS provisioning profile … skipping"  (exit 0)
make mas-dev     # → "No MAS development profile … skipping"    (exit 0)
make dist-appx   # → "APPX_IDENTITY_NAME / APPX_PUBLISHER unset … skipping" (exit 0)
make test        # full suite stays green (gates are false in a dev/test process)
```
