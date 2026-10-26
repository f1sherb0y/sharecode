#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 - <<'PY'
from pathlib import Path
import plistlib
p=Path('build/capture-benchmark/ShareCode Capture Filter Test.app/Contents')
(p/'MacOS').mkdir(parents=True,exist_ok=True)
(p/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'dev.sharecode.capture-filter-test','CFBundleName':'ShareCode Capture Filter Test','CFBundleExecutable':'CaptureBenchmark','CFBundlePackageType':'APPL','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True}))
p=Path('/tmp/sharecode-capture-benchmark');p.mkdir(exist_ok=True);(p/'command').write_text('idle:static:1920')
PY
xcrun clang -fobjc-arc -fmodules -c frontend/src-tauri-client/native/VirtualDisplay.m -o build/capture-benchmark/virtual.o
xcrun swiftc -O -target "$(uname -m)-apple-macosx14.0" frontend/src-tauri-client/native/CapturePolicy.swift frontend/src-tauri-client/native/VirtualDisplay.swift frontend/src-tauri-client/native/ScreenShare.swift frontend/src-tauri-client/native/ScreenshotCapture.swift frontend/scripts/capture-benchmark/main.swift build/capture-benchmark/virtual.o -o 'build/capture-benchmark/ShareCode Capture Filter Test.app/Contents/MacOS/CaptureBenchmark'
identity=$(python3 -c 'import json;print(json.load(open("docs/macos/signing-identity.json"))["sha1"])')
codesign --force --sign "$identity" 'build/capture-benchmark/ShareCode Capture Filter Test.app'
