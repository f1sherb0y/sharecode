# Building ShareCode

This guide covers building ShareCode for all platforms.

## Prerequisites

### All Platforms
- [Bun](https://bun.sh/) (recommended) or Node.js 18+
- [Rust](https://rustup.rs/) (latest stable)
- Git

### Linux (Debian/Ubuntu)
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libglib2.0-dev libcairo2-dev libgdk-pixbuf2.0-dev
```

### Windows
- Visual Studio 2022 Build Tools with "Desktop development with C++" workload
- WebView2 (pre-installed on Windows 10/11)

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
winget install Rustlang.Rust.MSVC
winget install oven-sh.Bun
```

### macOS
```bash
xcode-select --install
brew install rust
brew install oven-sh/bun/bun
```

## Building

### Web Only
```bash
cd frontend
bun install
bun run build
```

Output: `frontend/dist/`

### Logo and icons

`frontend/src/assets/sharecode-logo.svg` is the logo everywhere: the site and the customer client
show that file, and after changing it `cd frontend && node scripts/generate-icons.mjs` remakes the
favicons in `public/` and the icons in `src-tauri/icons/` (shared by both desktop apps; the macOS
`.icns` sits on Apple's icon grid with a drop shadow).

### Desktop App (Tauri)

```bash
cd frontend
bun install
bun run tauri build
```

### Customer Desktop Client (Tauri)

A separate app for customers (`frontend/src-tauri-client`, entry `client.html` → `src/client/`):
paste a share link (`https://kode666.com/s/<code>`) or the bare code, the client measures every
server node and connects to the fastest one, then shows the site's own share and room pages.
Nothing else from the site is bundled: `tooling/client-scope.ts` fails the build if other pages,
the schedule/work-table/layout code or the staff app's window helpers reach the bundle.

On Windows the client also carries three camouflage switches, in the title bar's Ghost panel
(`frontend/src-tauri-client/src/stealth.rs`): 共享隐藏 keeps the window out of every screen capture
and screen share (`SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`), 穿透 makes it take no mouse or
keyboard focus so every event reaches the app behind it (`WS_EX_NOACTIVATE | WS_EX_TRANSPARENT |
WS_EX_LAYERED`, flipped with `Ctrl+Shift+F` because a click-through window never sees the key press),
and 任务栏隐藏 removes the taskbar button and the Alt+Tab entry (`WS_EX_TOOLWINDOW`, `WS_EX_APPWINDOW`
cleared, `set_skip_taskbar`); the client has no tray icon. tao rewrites the whole `GWL_EXSTYLE` on
every window state change, so `stealth.rs` subclasses the window: it rewrites `styleNew` in
`WM_STYLECHANGING` and re-asserts the bits in `WM_STYLECHANGED`. To check a running build:

```bash
cd frontend
node scripts/inspect-stealth.mjs <pid>    # extended style bits, display affinity (17 = excluded)
node scripts/check-taskbar.mjs <pid>      # taskbar / Alt+Tab eligibility, real taskbar button count
node scripts/check-hit-test.mjs <pid>     # WindowFromPoint grid must never resolve to the client
node scripts/check-capture.mjs <pid>      # display affinity + what a BitBlt capture sees
```

All four read window state only: they never move the cursor, never send keys and never change the
window, so they are safe to run on a desktop that is in use.

```bash
cd frontend
bun install
# Release builds sign their updates (see "Releases and updates" below).
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/sharecode-client.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/sharecode-client.key.password)"
bun run client:tauri build
```

Outputs, in `src-tauri-client/target/release/bundle/` (`target/<target>/release/bundle/` with
`--target`), each update file with its `.sig` beside it:

| System | Installer (download button) | Update (in-app updater) |
|--------|-----------------------------|-------------------------|
| Windows | `nsis/ShareCode Client_<version>_x64-setup.exe` (per-user, no admin rights) | the installer and its `.sig` |
| macOS | `dmg/ShareCode Client_<version>_<arch>.dmg` | `macos/ShareCode Client.app.tar.gz` and its `.sig` |
| Linux | `appimage/ShareCode Client_<version>_amd64.AppImage` | the AppImage and its `.sig` |

Server nodes default to `https://kode666.com,https://collabcode.cc` (they serve the same
deployment). Override them at build time with `VITE_CLIENT_NODES`, e.g. for a local API:

```bash
VITE_CLIENT_NODES=http://127.0.0.1:3001 bun run client:tauri dev
```

`bun run client:dev` serves just the client UI at `http://localhost:5174/client.html`. Keep the
`tauri` crates in `src-tauri-client/Cargo.toml` on the minor version of `@tauri-apps/api`, and the
Tauri plugins on the minor version of their `@tauri-apps/plugin-*` packages.

The customer client uses one combined window/editor toolbar. Window settings include the
opacity controls; new windows default to 90% text and 65% background opacity. Custom saved
opacity is preserved. Enabling click-through (button or Ctrl+Shift+F) also pins the window;
disabling click-through keeps it pinned until it is explicitly unpinned.
As background opacity decreases, gray labels and borders move toward the theme foreground.
Menus, dialogs and Canvas controls use the same background opacity; text remains independently
adjustable. Native and Monaco scrollbars have transparent tracks and translucent thumbs that
adapt to the opacity and theme, with a minimum visibility floor for the thumb.

Headless client-chrome checks (no desktop input injection):

```bash
cd frontend
node --test tests/client-chrome.test.mjs
```

#### Releases and updates

Installed clients update themselves with Tauri's updater (`tauri-plugin-updater`). Five seconds
after launch and then every six hours they ask
`/api/client/update/{target}/{arch}/{version}` on kode666.com, then collabcode.cc. A newer signed
release downloads in the background and a 重启以更新 button appears in the title bar; it installs
the update and restarts (Windows runs the installer passively), and the saved seat reopens the
room. Nothing installs on its own in the middle of a session.

Updates are signed with a minisign key pair. The public key is `plugins.updater.pubkey` in
`src-tauri-client/tauri.conf.json` and `CLIENT_UPDATER_PUBKEY` in `server-rs/src/core/config.rs`
(a server test keeps them equal). The private key and its password never go in the repository:
they live in `~/.tauri/sharecode-client.key` and `~/.tauri/sharecode-client.key.password` on the
machine that builds releases. Back both up somewhere safe. If they are lost, installed clients can
never be updated again (customers would have to reinstall a client with a new key). Whoever has
them, plus an admin account, can ship code to every customer.

To release a version:

1. Raise `version` in `src-tauri-client/Cargo.toml` (a semantic version above the last one; it is
   the only version, `tauri.conf.json` has none) and merge it to `master`.
2. Tag that commit `client-v<version>` and push the tag. An annotated tag's message becomes the
   draft's notes, which the updater shows:

   ```bash
   git tag -a client-v0.1.2 -m "修复……"
   git push origin client-v0.1.2
   ```

   The release workflow (`.github/workflows/client-release.yml`) checks the tag against
   Cargo.toml, builds the Windows installer and the universal macOS DMG with signed updates, opens
   the version's draft on the server and uploads the files (the DMG and the `.app.tar.gz` under
   both macOS entries). Rerunning it replaces the draft's files. A hotfix is tagged on a branch
   made from the last release tag.
3. In 管理后台 → 客户端发布, check the draft and publish it. The server checks every signature
   against the client's public key, so a wrong or stale `.sig` is refused at upload instead of
   breaking updates later.
4. The download button on the login and join pages offers the newest installer for the visitor's
   system at once, and clients pick the update up on their next check. Unpublishing a version
   sends downloads and updates back to the previous one (clients never downgrade). A published
   version cannot be changed; unpublish it first.

Without the workflow, build on each system with the two signing variables set (on macOS
`scripts/build-client-macos.sh --signed-updates`, below), then create the version on the same page
and add the files: pick each installer and update together with its `.sig`; the page pairs them
and reads the system and type from the file names.

#### Release workflow setup

The workflow reads three repository secrets (Settings → Secrets and variables → Actions). GitHub
Free has no environment secrets for private repositories, so a workflow on any branch of this
repository can read them: give write access only to people trusted with the signing key.

- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: the contents of
  `~/.tauri/sharecode-client.key` and its password (`client-macos.yml` uses the same two).
- `CLIENT_RELEASES_CI_TOKEN`: a random token; the server keeps only its SHA-256.

  ```bash
  token=$(openssl rand -hex 32)
  printf %s "$token" | gh secret set CLIENT_RELEASES_CI_TOKEN
  printf %s "$token" | sha256sum | cut -d' ' -f1
  ```

  Set the printed digest as `CLIENT_RELEASES_CI_TOKEN_SHA256` in the server's environment and
  restart it. The token opens a draft (`PUT /api/ci/client-releases/{version}`: 201 new, 200
  already a draft, 409 published) and adds files to drafts through the admin upload route; it
  cannot list, publish, edit or delete anything. Its changes are audited as "CI workflow".
  Without the variable the route answers 404; changing or removing it revokes the token.

Run by hand (Actions → Client release → Run workflow), the workflow builds the same installers
without update signatures and keeps them as run artifacts for a week; it needs no secrets and
uploads nothing. It appears there only once the workflow is on the default branch; a tag runs the
workflow file of the tagged commit.

### macOS DMG without Apple Developer membership

The macOS customer shortcut uses a native listen-only event tap (macOS 10.15+), with no
global-hotkey fallback. Enable **Input Monitoring** from Window settings, then use **Test
shortcut**. Ctrl+Shift+F accepts either modifier side and works inside/background to the app,
without changing keyboard focus or restoring a minimized window. Reopening the app restores
its window. See `notes/client-hotkey-macos.md` for native acceptance checks.

Build a candidate universal installer (Apple silicon + Intel) on a Mac with the Command Line
Tools, Rust, Python 3.10+ and Bun 1.3.14 installed:

```bash
# From the repository root; no Apple account or updater private key required.
scripts/build-client-macos.sh
```

This uses the committed `bun.lock` and Cargo lockfile, runs the client Rust tests and the full
TypeScript/client build, bundles with the ad-hoc identity `-`, verifies the code signature and
both CPU architectures, then creates and verifies a compressed DMG. Pinned `dmgbuild`
dependencies are installed in the isolated `build/dmg-tools` environment. The Finder window
uses a Retina background with two aligned icons, a drag arrow and a brief bilingual first-launch
hint. It mounts the final image
read-only and verifies the packaged app again. No Finder automation, system-wide security
changes, installation, upload or publishing occurs.

The script prints a unique output directory under `build/macos-dist/`. It contains:

- `ShareCode Client_<version>_universal.dmg`: app and Applications shortcut over the visual installation background.
- `Install.html`: optional offline English/Chinese help for sharing alongside the download; not shown inside the DMG.
- `SHA256SUMS`: integrity checksums for the artifacts.
- `BUILD.txt`: commit, dirty-worktree flag, target, signing mode and build time.

For a smaller chip-specific installer, pass `--target aarch64-apple-darwin` or
`--target x86_64-apple-darwin`. Old successful builds are preserved in separate directories.

Artwork: edit `docs/macos/dmg-background.svg`, then run
`node frontend/scripts/render-dmg-background.mjs` (requires Playwright Chromium, installed with
`cd frontend && bunx playwright install chromium`, and Inter with Noto Sans CJK SC, or the macOS
system fonts). Commit the generated 1×/2×
PNGs with the SVG. Icon positions and window dimensions live in `scripts/macos-dmg-settings.py`;
keep them aligned with the artwork. Packaging combines both images into a Retina TIFF and
writes Finder metadata without AppleScript.

The default mode omits updater *artifacts*, since those need the existing minisign private key.
The installed app still checks updates with its original public key and endpoints. This DMG
can be shared directly or uploaded as a macOS installer for the download button; installed
clients update only from a signed `.app.tar.gz`.

To produce server-uploadable files, set `TAURI_SIGNING_PRIVATE_KEY` to the existing key contents
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to its password in your local secret environment, then:

```bash
scripts/build-client-macos.sh --signed-updates
```

This additionally produces the signed `.app.tar.gz` updater bundle, its `.sig`, and the DMG's
`.sig`. Never generate a replacement key for existing clients. For a universal build, upload
the same installer and update files under both `darwin-aarch64` and `darwin-x86_64` platforms.
Raise the Cargo version before publishing a new update. Run `just predeploy` against the exact
source before publishing/deploying; building a candidate installer does not replace that gate.

#### GitHub Actions

Merge `.github/workflows/client-macos.yml` into the repository's default branch so GitHub
registers the manual workflow, then open **Actions → Build macOS client DMG → Run workflow**,
choosing the branch to build (which must also contain the workflow). The default needs no secrets. It runs the client UI
suite in Chromium, Firefox and WebKit, then uses the same local build script. Download
`sharecode-client-macos-universal` from the completed run's artifacts and extract the DMG.
It does not create a GitHub Release or publish to production. Artifacts are retained for 30 days.

For the optional **signed_updates** mode, configure repository Actions secrets named
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` with the existing updater
credentials. Only the signing step receives them. No Apple membership or Apple secrets are used.

#### First launch

Ad-hoc signing is **not** Apple notarization. Users drag the app into Applications, try to open
it, and if blocked use **System Settings → Privacy & Security → Open Anyway**. This short hint
is on the DMG background. The optional detailed guide at `docs/macos/Install.html` is copied
next to the DMG for anyone who needs more help.
Managed Macs may require an administrator. Test an actual browser-downloaded DMG on a separate
Mac before public distribution; local signature verification does not test Gatekeeper approval,
Intel runtime behavior or the in-app update cycle.

References: [Tauri ad-hoc signing](https://v2.tauri.app/distribute/sign/macos/),
[Apple first-launch instructions](https://support.apple.com/en-us/102445).

### Build Outputs

| Platform | Output Location |
|----------|-----------------|
| Linux (deb) | `src-tauri/target/release/bundle/deb/ShareCode_*.deb` |
| Linux (rpm) | `src-tauri/target/release/bundle/rpm/ShareCode_*.rpm` |
| Linux (AppImage) | `src-tauri/target/release/bundle/appimage/ShareCode_*.AppImage` |
| Windows (exe) | `src-tauri/target/release/bundle/nsis/ShareCode_*-setup.exe` |
| Windows (msi) | `src-tauri/target/release/bundle/msi/ShareCode_*.msi` |
| macOS (dmg) | `src-tauri/target/release/bundle/dmg/ShareCode_*.dmg` |
| macOS (app) | `src-tauri/target/release/bundle/macos/ShareCode.app` |

## Development

### Web Dev Server
```bash
cd frontend
bun install
bun run dev
```

### Desktop Dev Mode
```bash
cd frontend
bun run tauri dev
```

## Code Signing (Optional)

### Windows
Set in `src-tauri/tauri.conf.json`:
```json
"windows": {
  "certificateThumbprint": "<your-cert-thumbprint>",
  "timestampUrl": "http://timestamp.digicert.com"
}
```

### macOS
Requires Apple Developer account. Set environment variables:
```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_ID="your@email.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAM_ID"
```

## Docker (Web Only)

```bash
docker compose up --build
```

This runs the full stack (backend + frontend) at `http://localhost:3000`.


### Optional WeMeet/VooV window privacy (Windows)

The Ghost menu has one **Hide meeting share overlays** switch, off by default. Enabling it
starts a one-second background scan of identified `wemeetapp.exe`, `voovmeeting.exe` and
`voovmeetingapp.exe` windows. Visible Qt `screen_share_tracker` / `screen_share_float_container`
markers activate handling for that process. Matching share markers and topmost meeting tool
windows request `WDA_EXCLUDEFROMCAPTURE`; running taskbar entries are removed locally as well.
Pinned shortcuts and notification-area tray icons are not removed.

`native/meeting_window_hook.rs` is built into a same-architecture helper DLL and embedded in the
client. A temporary, thread-specific `WH_CALLWNDPROC` hook applies display affinity from inside
the owning meeting process (Windows rejects setting another process's window affinity directly).
It does not patch meeting binaries, simulate input, or hook audio/video/network functions. Original
window affinity and the affected style bits are saved on the HWND; unrelated style bits remain intact.

Turning the switch off stops new modifications and restores the saved state. Stopping sharing
also restores changes. Failed restoration is reported and retried while the app runs. Normal exit
attempts restoration; after forced termination, reopen the client and toggle on/off to restore
remaining marked windows. Closing/restarting the meeting process also destroys these window states.
Only one ShareCode instance can manage meeting windows in a Windows session.

Capture exclusion depends on the recording application honoring Windows display affinity. Unknown
meeting window layouts, mismatched architectures, elevated targets or blocked DLL loading can fail;
the UI reports those failures. These paths have been compiled but require manual meeting and
capture validation; no live meeting was modified during implementation.


### Native client shortcuts

Windows and macOS both provide `Ctrl+Shift+F` to toggle click-through and `Ctrl+Shift+Q`
to quit, with either side's Ctrl and Shift keys. On Windows the hook and key-state recovery
share independent F/Q press latches, so holding one key does not repeat the action or block
the other shortcut. Quit uses Tauri's normal exit lifecycle, including the meeting-window
restoration attempt, without focusing the client first. macOS's Input Monitoring requirements
and existing quit handling are unchanged.
