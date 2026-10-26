#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
test_bundle="$PWD/build/share-visibility-test/ShareCode Visibility Test.app"
python3 - "$test_bundle" <<'PY'
import pathlib, plistlib, sys
p = pathlib.Path(sys.argv[1]) / 'Contents'
(p / 'MacOS').mkdir(parents=True, exist_ok=True)
(p / 'Info.plist').write_bytes(plistlib.dumps({
    'CFBundleIdentifier': 'dev.sharecode.visibility-test',
    'CFBundleName': 'ShareCode Visibility Test',
    'CFBundleExecutable': 'VisibilityTest',
    'CFBundlePackageType': 'APPL',
    'LSMinimumSystemVersion': '12.3',
    'NSHighResolutionCapable': True,
}))
PY
xcrun swiftc -O frontend/scripts/screen-share-visibility-test/main.swift -o "$test_bundle/Contents/MacOS/VisibilityTest"
codesign --force --sign - "$test_bundle"
echo "$test_bundle"
