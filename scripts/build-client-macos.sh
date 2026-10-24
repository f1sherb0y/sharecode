#!/bin/bash
# Build a candidate DMG locally or in CI. Does not publish or modify installed apps.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
target=universal-apple-darwin
updates=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="${2:?--target needs a Rust target}"; shift 2 ;;
    --signed-updates) updates=true; shift ;;
    --help) echo 'Usage: scripts/build-client-macos.sh [--target universal-apple-darwin|aarch64-apple-darwin|x86_64-apple-darwin] [--signed-updates]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo 'Build this installer on macOS.' >&2; exit 1; }
case "$target" in
  universal-apple-darwin) targets=(aarch64-apple-darwin x86_64-apple-darwin); arch=universal ;;
  aarch64-apple-darwin) targets=(aarch64-apple-darwin); arch=aarch64 ;;
  x86_64-apple-darwin) targets=(x86_64-apple-darwin); arch=x64 ;;
  *) echo "Unsupported macOS target: $target" >&2; exit 1 ;;
esac
if [[ "$updates" == true && -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo '--signed-updates requires the EXISTING TAURI_SIGNING_PRIVATE_KEY; do not generate a replacement key.' >&2
  exit 1
fi
for command in bun cargo rustup xcrun codesign hdiutil ditto shasum python3; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
xcrun --sdk macosx --show-sdk-path >/dev/null
packaging_env="$root/build/dmg-tools"
[[ -x "$packaging_env/bin/python" ]] || python3 -m venv "$packaging_env"
"$packaging_env/bin/python" -m pip install --disable-pip-version-check -r "$root/scripts/macos-dmg-requirements.txt"
rustup target add "${targets[@]}"

# This pipeline is explicitly ad-hoc. Never pick up Apple credentials from a local shell.
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
export APPLE_SIGNING_IDENTITY=-
export CARGO_TARGET_DIR="$root/frontend/src-tauri-client/target"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
cd "$root/frontend"
bun install --frozen-lockfile
cargo test --locked --manifest-path src-tauri-client/Cargo.toml
# beforeBuildCommand runs the complete TypeScript + client production build (including scope guard).
bun run client:tauri build --ci --target "$target" --bundles app \
  --config "{\"bundle\":{\"createUpdaterArtifacts\":$updates,\"macOS\":{\"signingIdentity\":\"-\"}}}" -- --locked

bundle="$CARGO_TARGET_DIR/$target/release/bundle/macos"
app="$bundle/ShareCode Client.app"
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
codesign --verify --deep --strict --verbose=2 "$app"
# Check the native architectures, not just the filename.
for cpu in "${targets[@]}"; do
  case "$cpu" in aarch64-*) cpu=arm64 ;; x86_64-*) cpu=x86_64 ;; esac
  xcrun lipo "$app/Contents/MacOS/sharecode-client" -verify_arch "$cpu"
done

mkdir -p "$root/build/macos-dist"
work=$(mktemp -d "$root/build/macos-dist/.packaging.XXXXXX")
mountpoint="$work/mounted"
mounted=false
cleanup() {
  if [[ "$mounted" == true ]]; then hdiutil detach "$mountpoint" >/dev/null || true; fi
  # Only the unique temporary packaging directory is removed, never a prior build.
  python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$work"
}
trap cleanup EXIT
mkdir -p "$work/artifacts" "$mountpoint"
cp "$root/docs/macos/Install.html" "$work/artifacts/Install.html"
name="ShareCode Client_${version}_${arch}"
dmg="$work/artifacts/$name.dmg"
# Write Finder background/positions directly, without Finder automation or desktop input.
"$packaging_env/bin/dmgbuild" -s "$root/scripts/macos-dmg-settings.py" -D "root=$root" -D "app=$app" 'ShareCode Client' "$dmg"
hdiutil verify "$dmg"
hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$dmg" >/dev/null
mounted=true
codesign --verify --deep --strict --verbose=2 "$mountpoint/ShareCode Client.app"
[[ -f "$mountpoint/.background.tiff" && -f "$mountpoint/.DS_Store" && "$(readlink "$mountpoint/Applications")" == /Applications ]]
"$packaging_env/bin/python" "$root/scripts/verify-macos-dmg.py" "$mountpoint"
hdiutil detach "$mountpoint" >/dev/null
mounted=false

if [[ "$updates" == true ]]; then
  # Tauri creates the signed .app.tar.gz. The release server also requires a .sig for the DMG.
  cp "$bundle/ShareCode Client.app.tar.gz" "$work/artifacts/$name.app.tar.gz"
  cp "$bundle/ShareCode Client.app.tar.gz.sig" "$work/artifacts/$name.app.tar.gz.sig"
  bun run tauri signer sign "$dmg"
fi
cd "$root"
commit=$(git rev-parse HEAD)
dirty=false
[[ -z "$(git status --porcelain)" ]] || dirty=true
cat > "$work/artifacts/BUILD.txt" <<META
ShareCode Client $version
Target: $target
Source commit: $commit
Working tree has changes: $dirty
Apple signature: ad-hoc (not notarized; first launch needs Open Anyway)
Updater artifacts: $updates
Built at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
Candidate build only. Run just predeploy before publishing/deploying.
META
(cd "$work/artifacts" && shasum -a 256 ./* > SHA256SUMS)
mode=manual
[[ "$updates" == false ]] || mode=updates
output=$(mktemp -d "$root/build/macos-dist/${version}-${arch}-${mode}.XXXXXX")
# Preserve successful prior builds and never mix stale signatures with a new DMG.
for file in "$work/artifacts/"*; do mv "$file" "$output/"; done
printf '\nVerified installer artifacts: %s\n' "$output"
