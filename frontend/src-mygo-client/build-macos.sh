#!/bin/bash
# Builds the macOS client into build/mygo-client. Nothing is installed or uploaded.
# test-macos.sh runs the tests.
#
#   ./build-macos.sh                                  development client, beside a real one
#   ./build-macos.sh --release --version 0.2.8        the released identity, as a disk image
#   ./build-macos.sh --release --version 0.2.8 --signed-updates   and the signed update
#
# Both are universal apps signed with the fixed self-signed certificate
# (docs/macos/signing-identity.json): macOS ties Input Monitoring and Screen
# Recording to it, so a rebuilt app keeps them. --adhoc signs a development
# client without the certificate; its permissions are asked again after every build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

version=0.2.7
release=false
updates=false
adhoc=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:?--version needs major.minor.patch}"; shift 2 ;;
    --release) release=true; shift ;;
    --signed-updates) updates=true; shift ;;
    --adhoc) adhoc=true; shift ;;
    --help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo 'Build this client on macOS.' >&2; exit 1; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'The version must be major.minor.patch' >&2; exit 1; }
if [[ "$release" == true && "$adhoc" == true ]]; then
  echo 'A release is signed with the fixed certificate.' >&2; exit 1
fi
if [[ "$updates" == true && ( "$release" == false || -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ) ]]; then
  echo '--signed-updates is for --release and needs the EXISTING TAURI_SIGNING_PRIVATE_KEY; do not generate a replacement key.' >&2
  exit 1
fi
# Import only the pinned identity, in a temporary keychain owned by this invocation.
if [[ "$adhoc" == false && -z "${SHARECODE_SIGNING_KEYCHAIN:-}" ]]; then
  args=(--version "$version")
  [[ "$release" == false ]] || args+=(--release)
  [[ "$updates" == false ]] || args+=(--signed-updates)
  exec python3 "$root/scripts/macos-signing.py" run -- bash "$0" "${args[@]}"
fi
for command in bun go xcrun codesign python3; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done

if [[ "$release" == true ]]; then
  name=sharecode-client; product='ShareCode Client'; identifier=dev.sharecode.client
else
  name=sharecode-client-mygo-dev; product='ShareCode Client (MyGo Development)'; identifier=dev.sharecode.client.mygo-dev
fi
out="$root/build/mygo-client"
stage="$out/darwin-universal"
app="$stage/$product.app"

cd "$here"
./nativemac/build-native.sh

# mygo.config.ts and identity.go read the same identity and version.
export SHARECODE_MYGO_RELEASE_BUILD=$([[ "$release" == true ]] && echo 1 || echo 0)
export SHARECODE_MYGO_VERSION="$version"
export MYGO_LDFLAGS="-X main.applicationID=$identifier -X main.applicationName=$name -X main.applicationVersion=$version"
# MyGo signs ad hoc here: the certificate signs below, without the secure
# timestamp MyGo adds for a Developer ID, and the disk image keeps this
# project's own layout.
go run github.com/egoist/mygo/cmd/mygo build -platform darwin/universal -skip-dmg -sign - -o "$out"
built="$stage/$name.app"
[[ -x "$built/Contents/MacOS/$name" ]] || { echo "MyGo did not build $built" >&2; exit 1; }
if [[ "$built" != "$app" ]]; then
  [[ ! -e "$app" ]] || python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1])' "$app"
  mv "$built" "$app"
fi
for cpu in arm64 x86_64; do
  xcrun lipo "$app/Contents/MacOS/$name" -verify_arch "$cpu"
  xcrun lipo "$app/Contents/Resources/libsharecode_native.dylib" -verify_arch "$cpu"
done

if [[ "$adhoc" == true ]]; then
  codesign --force --sign - "$app/Contents/Resources/libsharecode_native.dylib"
  codesign --force --sign - "$app"
  codesign --verify --deep --strict "$app"
  echo "Built $app (ad-hoc signature: macOS asks for its permissions again after every build)"
  exit 0
fi
identity=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sha1"])' "$root/docs/macos/signing-identity.json")
# Inside out: the library first, then the app that seals it.
codesign --force --sign "$identity" --options runtime "$app/Contents/Resources/libsharecode_native.dylib"
codesign --force --sign "$identity" --options runtime --entitlements "$here/packaging/macos-entitlements.plist" "$app"
python3 "$root/scripts/macos-signing.py" verify "$app" --identifier "$identifier"
if [[ "$release" == false ]]; then
  echo "Built $app"
  exit 0
fi

# The disk image of the Tauri client: same layout, tools and checks.
for command in hdiutil shasum; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
packaging_env="$root/build/dmg-tools"
[[ -x "$packaging_env/bin/python" ]] || python3 -m venv "$packaging_env"
"$packaging_env/bin/python" -m pip install --quiet --disable-pip-version-check -r "$root/scripts/macos-dmg-requirements.txt"
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
artifact="ShareCode Client_${version}_universal"
dmg="$work/artifacts/$artifact.dmg"
# Finder's background and positions are written directly, without Finder automation.
"$packaging_env/bin/dmgbuild" -s "$root/scripts/macos-dmg-settings.py" -D "root=$root" -D "app=$app" 'ShareCode Client' "$dmg"
hdiutil verify "$dmg" >/dev/null
hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "$dmg" >/dev/null
mounted=true
python3 "$root/scripts/macos-signing.py" verify "$mountpoint/ShareCode Client.app"
[[ -f "$mountpoint/.background.tiff" && -f "$mountpoint/.DS_Store" && "$(readlink "$mountpoint/Applications")" == /Applications ]]
"$packaging_env/bin/python" "$root/scripts/verify-macos-dmg.py" "$mountpoint"
hdiutil detach "$mountpoint" >/dev/null
mounted=false

if [[ "$updates" == true ]]; then
  # The archive installed clients update from, Tauri ones included: the app
  # under its own name, without AppleDouble files.
  archive="$work/artifacts/$artifact.app.tar.gz"
  COPYFILE_DISABLE=1 tar -czf "$archive" -C "$stage" "$product.app"
  # Check the exact app inside the archive too, as it will be installed.
  mkdir "$work/update-check"
  tar -xzf "$archive" -C "$work/update-check"
  python3 "$root/scripts/macos-signing.py" verify "$work/update-check/ShareCode Client.app"
  # The release server wants a signature for the disk image as well.
  go run ./cmd/sign-update -file "$archive"
  go run ./cmd/sign-update -file "$dmg"
fi
commit=$(git -C "$root" rev-parse HEAD)
dirty=false
[[ -z "$(git -C "$root" status --porcelain)" ]] || dirty=true
cat > "$work/artifacts/BUILD.txt" <<META
ShareCode Client $version (MyGo host)
Target: darwin/universal
Source commit: $commit
Working tree has changes: $dirty
macOS signature: fixed self-signed certificate $identity (not notarized; first launch needs Open Anyway)
Updater artifacts: $updates
Built at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
Candidate build only. Run just predeploy before publishing/deploying.
META
(cd "$work/artifacts" && shasum -a 256 ./* > SHA256SUMS)
mode=manual
[[ "$updates" == false ]] || mode=updates
output=$(mktemp -d "$root/build/macos-dist/${version}-universal-mygo-${mode}.XXXXXX")
# Earlier builds stay, and a new disk image never sits beside stale signatures.
for file in "$work/artifacts/"*; do mv "$file" "$output/"; done
printf '\nVerified installer artifacts: %s\n' "$output"
