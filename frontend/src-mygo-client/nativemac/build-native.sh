#!/bin/bash
# Compiles the client's native macOS code into resources/darwin/libsharecode_native.dylib,
# a universal library the MyGo build ships in the app's resources and signs with it.
# The capture, virtual display, pinning and placement sources are the Tauri client's
# (src-tauri-client/native); native/ holds what replaces its Rust.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
shared="$here/../../src-tauri-client/native"
out="$here/../resources/darwin"
work=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-native.XXXXXX")
trap 'rm -rf "$work"' EXIT
sdk=$(xcrun --sdk macosx --show-sdk-path)
mkdir -p "$out"

for arch in arm64 x86_64; do
  target="$arch-apple-macosx12.0"
  xcrun clang -fobjc-arc -fmodules -target "$target" -isysroot "$sdk" \
    -c "$shared/VirtualDisplay.m" -o "$work/virtual_display_$arch.o"
  # ScreenCaptureKit is weak-linked: the listener and the window work before macOS 12.3.
  xcrun swiftc -swift-version 5 -parse-as-library -emit-library -O \
    -module-name ShareCodeNative -target "$target" -sdk "$sdk" \
    -Xfrontend -disable-autolink-framework -Xfrontend ScreenCaptureKit \
    "$shared/CapturePolicy.swift" "$shared/VirtualDisplay.swift" "$shared/ScreenShare.swift" \
    "$shared/ScreenshotCapture.swift" "$shared/PermissionPlacement.swift" "$shared/WindowPinning.swift" \
    "$here/native/ClientWindow.swift" "$work/virtual_display_$arch.o" \
    -Xlinker -weak_framework -Xlinker ScreenCaptureKit \
    -Xlinker -install_name -Xlinker @rpath/libsharecode_native.dylib \
    -o "$work/libsharecode_native_$arch.dylib"
done
xcrun lipo -create "$work/libsharecode_native_arm64.dylib" "$work/libsharecode_native_x86_64.dylib" \
  -output "$out/libsharecode_native.dylib"
xcrun lipo "$out/libsharecode_native.dylib" -verify_arch arm64 x86_64
echo "Built $out/libsharecode_native.dylib"
