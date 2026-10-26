#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
python3 - <<'PY'
from pathlib import Path
import plistlib
for name, identifier in [('ShareCode Capture Filter Test','dev.sharecode.capture-filter-test'), ('ShareCode Filter Source','dev.sharecode.capture-source-test'), ('Synthetic Excluded Meeting Helper','com.tencent.meeting.sharecode-capture-test')]:
    p=Path('build/capture-indicator-test', name+'.app', 'Contents')
    (p/'MacOS').mkdir(parents=True,exist_ok=True)
    (p/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':identifier,'CFBundleName':name,'CFBundleExecutable':'CaptureProbe','CFBundlePackageType':'APPL','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True}))
p=Path('/tmp/sharecode-capture-indicator-test')
p.mkdir(exist_ok=True)
(p/'command').write_text('stop')
PY
identity=$(python3 -c 'import json; print(json.load(open("docs/macos/signing-identity.json"))["sha1"])')
xcrun clang -fobjc-arc -fmodules -target "$(uname -m)-apple-macosx14.0" -c frontend/src-tauri-client/native/VirtualDisplay.m -o build/capture-indicator-test/virtual.o
xcrun swiftc -O -D CAPTURE_PROBE -target "$(uname -m)-apple-macosx14.0" \
  frontend/src-tauri-client/native/CapturePolicy.swift frontend/src-tauri-client/native/ScreenshotCapture.swift \
  frontend/src-tauri-client/native/VirtualDisplay.swift frontend/src-tauri-client/native/ScreenShare.swift \
  frontend/scripts/capture-indicator-test/main.swift build/capture-indicator-test/virtual.o \
  -o 'build/capture-indicator-test/ShareCode Capture Filter Test.app/Contents/MacOS/CaptureProbe'
xcrun swiftc -O frontend/scripts/capture-indicator-test/source/main.swift -o 'build/capture-indicator-test/ShareCode Filter Source.app/Contents/MacOS/CaptureProbe'
codesign --force --sign "$identity" 'build/capture-indicator-test/ShareCode Capture Filter Test.app'
codesign --force --sign "$identity" 'build/capture-indicator-test/ShareCode Filter Source.app'

xcrun swiftc -O frontend/scripts/capture-indicator-test/excluded/main.swift -o 'build/capture-indicator-test/Synthetic Excluded Meeting Helper.app/Contents/MacOS/CaptureProbe'
codesign --force --sign "$identity" 'build/capture-indicator-test/Synthetic Excluded Meeting Helper.app'
