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
