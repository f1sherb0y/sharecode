#!/bin/bash
# Actual display test: no recording/input permissions, no app installation.
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-virtual-display.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
xcrun clang -fobjc-arc -fmodules -target "$(uname -m)-apple-macosx12.3" -c src-tauri-client/native/VirtualDisplay.m -o "$test_dir/virtual.o"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macosx12.3" src-tauri-client/native/CapturePolicy.swift \
  src-tauri-client/native/VirtualDisplay.swift src-tauri-client/native/ScreenShare.swift src-tauri-client/native/ScreenshotCapture.swift \
  src-tauri-client/native/tests/virtual-display/main.swift "$test_dir/virtual.o" \
  -o "$test_dir/virtual-display-test"
"$test_dir/virtual-display-test"
