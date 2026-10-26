#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
python3 - <<'PY'
from pathlib import Path
import plistlib
for name, role in [('ShareCode Fullscreen Host', 'host'), ('ShareCode Pin Test', 'overlay')]:
    p = Path('build/fullscreen-pin-test', name + '.app', 'Contents')
    (p / 'MacOS').mkdir(parents=True, exist_ok=True)
    (p / 'Info.plist').write_bytes(plistlib.dumps({
        'CFBundleIdentifier': 'dev.sharecode.fullscreen-pin-test.' + role,
        'CFBundleName': name, 'CFBundleExecutable': 'PinTest',
        'CFBundlePackageType': 'APPL', 'NSHighResolutionCapable': True,
    }))
p = Path('/tmp/sharecode-fullscreen-pin-test')
p.mkdir(exist_ok=True)
(p / 'command').write_text('pin')
PY
xcrun swiftc -O frontend/src-tauri-client/native/WindowPinning.swift \
  frontend/src-tauri-client/native/tests/pinning/main.swift \
  -o 'build/fullscreen-pin-test/ShareCode Pin Test.app/Contents/MacOS/PinTest'
cp 'build/fullscreen-pin-test/ShareCode Pin Test.app/Contents/MacOS/PinTest' \
  'build/fullscreen-pin-test/ShareCode Fullscreen Host.app/Contents/MacOS/PinTest'
codesign --force --sign - 'build/fullscreen-pin-test/ShareCode Pin Test.app'
codesign --force --sign - 'build/fullscreen-pin-test/ShareCode Fullscreen Host.app'
echo 'Built isolated host and overlay apps in build/fullscreen-pin-test (not launched).'
