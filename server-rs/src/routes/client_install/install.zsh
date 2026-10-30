# ShareCode Client for macOS: installs the newest version into /Applications, or updates or
# repairs an existing install. Run it from Terminal with the command on the download page:
#   /bin/zsh -c "$(curl -fsSL {{ORIGIN}}/api/client/install.sh)"
# The server fills in the release below. Downloads keep no quarantine attribute, the script
# clears any left by an earlier browser download (the app is signed with a self-signed
# certificate, which Gatekeeper refuses), and the app is left owned by you, so the client
# updates itself without asking for a password.

emulate -R zsh
setopt pipe_fail no_unset

APP_NAME='ShareCode Client'
BUNDLE_ID='dev.sharecode.client'
BINARY='sharecode-client'
ORIGIN='{{ORIGIN}}'
TARGET="/Applications/$APP_NAME.app"

if [[ -t 2 ]]; then red=$'\e[31m' reset=$'\e[0m'; else red='' reset=''; fi
fail() { print -r -- "${red}Error: $1${reset}" >&2; exit 1; }

work=''
mounted=''
cleanup() {
  [[ -n $mounted ]] && { hdiutil detach -quiet "$mounted" 2>/dev/null || hdiutil detach -quiet -force "$mounted" 2>/dev/null; }
  [[ -n $work ]] && { rm -rf "$work" 2>/dev/null || sudo -n rm -rf "$work" 2>/dev/null; }
  sudo -k 2>/dev/null
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

[[ $(uname -s) == Darwin ]] || fail 'This command is for macOS only.'
autoload -Uz is-at-least
os_version=$(sw_vers -productVersion 2>/dev/null)
is-at-least 10.15 "$os_version" || fail "Requires macOS 10.15 or later (this Mac runs $os_version)."

# Apple silicon reports arm64 even in a shell running under Rosetta.
if [[ $(sysctl -n hw.optional.arm64 2>/dev/null) == 1 ]]; then
  version='{{ARM64_VERSION}}' url='{{ARM64_URL}}' sha256='{{ARM64_SHA256}}'
else
  version='{{X64_VERSION}}' url='{{X64_URL}}' sha256='{{X64_SHA256}}'
fi
[[ -n $url ]] || fail 'No version is available for this Mac yet.'

work=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-install.XXXXXX") || fail 'Could not create a temporary folder.'

print -r -- "Downloading $APP_NAME $version..."
curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$work/client.dmg" "$ORIGIN$url" \
  || fail 'Download failed. Check your connection and try again.'
actual=$(shasum -a 256 "$work/client.dmg" | awk '{print $1}')
[[ $actual == "$sha256" ]] || fail 'Download was incomplete. Try again.'

mkdir "$work/volume"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -noverify -mountpoint "$work/volume" "$work/client.dmg" \
  || fail 'Could not open the disk image.'
mounted="$work/volume"
source_app="$mounted/$APP_NAME.app"
[[ -d $source_app && $(defaults read "$source_app/Contents/Info" CFBundleIdentifier 2>/dev/null) == "$BUNDLE_ID" ]] \
  || fail 'The disk image does not contain the client.'

sudo -v -p 'Mac password (typing is hidden): ' || fail 'Administrator password required.'

# Quit a running client only once the install can go ahead.
if pgrep -qx "$BINARY"; then
  pkill -x "$BINARY"
  for attempt in {1..20}; do
    pgrep -qx "$BINARY" || break
    sleep 0.5
  done
  pkill -9 -x "$BINARY" 2>/dev/null
fi

staging="/Applications/.$APP_NAME.app.installing"
sudo rm -rf "$staging"
sudo ditto "$source_app" "$staging" || { sudo rm -rf "$staging"; fail 'Could not copy the app.'; }
# Remove the quarantine flag Gatekeeper checks, and make the app yours so updates need no password.
sudo xattr -dr com.apple.quarantine "$staging" 2>/dev/null
sudo chown -R "$(id -un):$(id -gn)" "$staging"
hdiutil detach -quiet "$mounted" 2>/dev/null && mounted=''

if [[ -e $TARGET ]]; then
  # App Management (System Settings → Privacy & Security) can forbid Terminal from replacing it.
  if ! sudo mv "$TARGET" "$work/previous.app" 2>/dev/null; then
    sudo rm -rf "$staging"
    fail "Could not replace the installed app. Move $APP_NAME from Applications to the Trash and try again."
  fi
fi
if ! sudo mv "$staging" "$TARGET"; then
  [[ -e $work/previous.app ]] && sudo mv "$work/previous.app" "$TARGET"
  sudo rm -rf "$staging"
  fail 'Install failed; the previous version was kept.'
fi
sudo rm -rf "$work/previous.app"
# A copy downloaded earlier through a browser may still be marked anywhere inside.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
sudo -k

open "$TARGET" 2>/dev/null
print -r -- "Installed $APP_NAME $version."
