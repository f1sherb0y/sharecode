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
   the only version, `tauri.conf.json` has none).
2. Build on each system with the two signing variables set. On macOS build
   `bun run client:tauri build --target universal-apple-darwin`, which runs on both chips, and
   upload its files for both macOS entries.
3. In 管理后台 → 客户端发布, create the version, add the files (pick each installer and update
   together with its `.sig`; the page pairs them and reads the system and type from the file
   names), and publish. The server checks every signature against the client's public key, so a
   wrong or stale `.sig` is refused at upload instead of breaking updates later.
4. The download button on the login and join pages offers the newest installer for the visitor's
   system at once, and clients pick the update up on their next check. Unpublishing a version
   sends downloads and updates back to the previous one (clients never downgrade). A published
   version cannot be changed; unpublish it first.

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
