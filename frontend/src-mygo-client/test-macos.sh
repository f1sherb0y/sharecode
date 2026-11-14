#!/bin/bash
# Runs every test of the macOS client. All of them use their own windows,
# directories and browsing session: no installed client, saved session, update
# server or permission is touched, no input is generated and System Settings is
# never opened.
#
# Run build-macos.sh first: the window tests load the embedded frontend and the
# native library it builds. They show a small window and the client's own for
# a few seconds, and hold the Option+Shift chords while they run.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

cd "$here/.."
node --test tests/client-chrome.test.mjs tests/i18n.test.mjs src/client/mygo.test.mjs

cd "$here"
[[ -f resources/darwin/libsharecode_native.dylib && -f assets/web/client.html ]] || {
  echo 'Run build-macos.sh first.' >&2; exit 1
}
go vet ./...
go vet -tags mygo_smoke . ./nativemac
go test -count=1 ./...
export SHARECODE_MYGO_NATIVE_SMOKE=1
# Real MyGo panels with WebKit: the switches, pinning, moving and hiding, read back from AppKit.
go test -tags mygo_smoke -run TestMyGo -count=1 ./nativemac
# The real host with the real page: the permission gate and its guide, the page's commands, the update gate.
go test -tags mygo_smoke -run TestHost -count=1 .
echo 'macOS client tests passed.'
