#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-capture-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc src-tauri-client/native/CapturePolicy.swift src-tauri-client/native/PermissionPlacement.swift src-tauri-client/native/tests/main.swift -o "$test_dir/policy-test"
"$test_dir/policy-test"
xcrun swiftc -O -target "$(uname -m)-apple-macosx12.3" src-tauri-client/native/ScreenshotCapture.swift src-tauri-client/native/tests/screenshots/main.swift -o "$test_dir/screenshot-test"
"$test_dir/screenshot-test"
for arch in arm64 x86_64; do
  xcrun clang -fobjc-arc -fmodules -target "$arch-apple-macosx10.15" -fsyntax-only src-tauri-client/native/VirtualDisplay.m
  xcrun swiftc -swift-version 5 -parse-as-library -typecheck -target "$arch-apple-macosx10.15" \
    src-tauri-client/native/CapturePolicy.swift src-tauri-client/native/VirtualDisplay.swift src-tauri-client/native/ScreenShare.swift src-tauri-client/native/ScreenshotCapture.swift src-tauri-client/native/PermissionPlacement.swift src-tauri-client/native/WindowPinning.swift
done
echo "Native capture typechecked for Apple silicon and Intel (10.15 deployment, 12.3 availability gate)"
