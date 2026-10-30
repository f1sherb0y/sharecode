#!/bin/sh
# Runs the macOS install script (rendered like the server does) through each scenario, with
# stand-ins for the macOS tools on PATH; see test-macos.sh. Linux container only: it rewrites /Applications.
set -u
apk add -q zsh >/dev/null
sh /harness/macos-stubs.sh
mkdir -p /fixtures/volume/"ShareCode Client.app"/Contents/MacOS
printf 'CFBundleIdentifier=dev.sharecode.client\nCFBundleShortVersionString=9.9.9\n' > "/fixtures/volume/ShareCode Client.app/Contents/Info.keys"
echo new-binary > "/fixtures/volume/ShareCode Client.app/Contents/MacOS/sharecode-client"
echo dmg-bytes > /fixtures/client.dmg
sha=$(sha256sum /fixtures/client.dmg | cut -d' ' -f1)
render() { sed -e "s|{{ORIGIN}}|https://kode666.com|g" -e "s|{{ARM64_VERSION}}|9.9.9|g" -e "s|{{X64_VERSION}}|9.9.8|g" \
  -e "s|{{ARM64_URL}}|/api/client/downloads/a/arm.dmg|g" -e "s|{{X64_URL}}|${X64_URL-/api/client/downloads/b/intel.dmg}|g" \
  -e "s|{{ARM64_SHA256}}|${SHA:-$sha}|g" -e "s|{{X64_SHA256}}|${SHA:-$sha}|g" /template/install.zsh; }
APP="/Applications/ShareCode Client.app"
export LOG=/tmp/log PATH=/stubs:$PATH
pass=0; failed=0
check() { if eval "$2"; then pass=$((pass+1)); else failed=$((failed+1)); echo "  FAIL: $1"; echo "  --- output"; sed 's/^/  | /' /tmp/out; echo "  --- calls"; sed 's/^/  | /' $LOG; fi; }
scenario() {
  echo "== $1"; rm -rf /Applications /tmp/running "$LOG" /tmp/sharecode-install.*; mkdir -p /Applications; : > $LOG
}
run() { /bin/zsh -c "$(render)" > /tmp/out 2>&1; echo $? > /tmp/code; }

scenario 'fresh install on Apple silicon'
run
check 'exits 0' '[ "$(cat /tmp/code)" = 0 ]'
check 'app installed' '[ "$(cat "$APP/Contents/MacOS/sharecode-client")" = new-binary ]'
check 'downloads the arm64 build from the origin' 'grep -q "curl .*https://kode666.com/api/client/downloads/a/arm.dmg" $LOG'
check 'quarantine cleared' 'grep -q "xattr -dr com.apple.quarantine" $LOG'
check 'owned by the user' '[ "$(stat -c %U "$APP")" = "$(id -un)" ]'
check 'opened' 'grep -q "open $APP" $LOG'
check 'disk image detached' 'grep -q "hdiutil detach" $LOG'
check 'no staging left' '[ ! -e "/Applications/.ShareCode Client.app.installing" ]'
check 'temp removed' '! ls -d /tmp/sharecode-install.* >/dev/null 2>&1'
check 'sudo forgotten' 'grep -q "sudo -k" $LOG'
check 'asks for the password' 'grep -q "Mac password (typing is hidden): " /tmp/out'
check 'reports success' 'grep -q "Installed ShareCode Client 9.9.9." /tmp/out'
check 'English only' '! LC_ALL=C grep -q "[^ -~]" /tmp/out'

scenario 'update over a running older version on Intel'
mkdir -p "$APP/Contents/MacOS"; echo old > "$APP/Contents/MacOS/sharecode-client"
printf 'CFBundleIdentifier=dev.sharecode.client\nCFBundleShortVersionString=0.1.0\n' > "$APP/Contents/Info.keys"
touch /tmp/running
ARM=0 run
check 'exits 0' '[ "$(cat /tmp/code)" = 0 ]'
check 'downloads the Intel build' 'grep -q "curl .*/b/intel.dmg" $LOG'
check 'quits the client' 'grep -q "pkill -x sharecode-client" $LOG'
check 'replaced' '[ "$(cat "$APP/Contents/MacOS/sharecode-client")" = new-binary ]'

scenario 'corrupted download'
SHA=0000 run
check 'fails' '[ "$(cat /tmp/code)" = 1 ] && grep -q "Download was incomplete" /tmp/out'
check 'never asks for the password' '! grep -q "sudo -v" $LOG'
check 'nothing installed' '[ ! -e "$APP" ]'
check 'temp removed' '! ls -d /tmp/sharecode-install.* >/dev/null 2>&1'

scenario 'download fails'
CURL_FAIL=1 run
check 'fails with the network message' '[ "$(cat /tmp/code)" = 1 ] && grep -q "Download failed" /tmp/out'

scenario 'not an administrator'
touch /tmp/running
SUDO_FAIL=1 run
check 'leaves the running client alone' '! grep -q pkill $LOG'
check 'fails with the admin message' '[ "$(cat /tmp/code)" = 1 ] && grep -q "Administrator password required" /tmp/out'
check 'nothing installed' '[ ! -e "$APP" ] && [ ! -e "/Applications/.ShareCode Client.app.installing" ]'
check 'disk image detached' 'grep -q "hdiutil detach" $LOG'

scenario 'installed app cannot be moved (App Management)'
mkdir -p "$APP/Contents/MacOS"; echo old > "$APP/Contents/MacOS/sharecode-client"
MV_FAIL=1 run
check 'fails with the Finder hint' '[ "$(cat /tmp/code)" = 1 ] && grep -q "to the Trash" /tmp/out'
check 'old app kept' '[ "$(cat "$APP/Contents/MacOS/sharecode-client")" = old ]'
check 'no staging left' '[ ! -e "/Applications/.ShareCode Client.app.installing" ]'

scenario 'macOS too old'
SW_VERS=10.14.6 run
check 'refuses' '[ "$(cat /tmp/code)" = 1 ] && grep -q "Requires macOS 10.15" /tmp/out'

scenario 'nothing published for this Mac'
X64_URL='' ARM=0 run
check 'Intel Mac without a build is told so' '[ "$(cat /tmp/code)" = 1 ] && grep -q "No version is available for this Mac" /tmp/out'

echo
echo "passed $pass, failed $failed"
[ $failed = 0 ]
