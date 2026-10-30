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

if [[ -t 1 ]]; then
  bold=$'\e[1m' red=$'\e[31m' green=$'\e[32m' reset=$'\e[0m'
else
  bold='' red='' green='' reset=''
fi
step() { print -r -- ""; print -r -- "${bold}==> $1${reset}"; }
say() { print -r -- "    $1"; }
fail() {
  print -r -- "" >&2
  print -r -- "${red}${bold}安装失败 / Installation failed${reset}" >&2
  local line
  for line in "$@"; do print -r -- "    $line" >&2; done
  exit 1
}

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

print -r -- "${bold}ShareCode Client${reset}"

[[ $(uname -s) == Darwin ]] || fail '这条命令只适用于 Mac。' 'This command is for macOS only.'
autoload -Uz is-at-least
os_version=$(sw_vers -productVersion 2>/dev/null)
is-at-least 10.15 "$os_version" || fail "需要 macOS 10.15 或更新版本（这台 Mac 是 $os_version）。" "macOS 10.15 or later is required (this Mac runs $os_version)."

# Apple silicon reports arm64 even in a shell running under Rosetta.
if [[ $(sysctl -n hw.optional.arm64 2>/dev/null) == 1 ]]; then
  version='{{ARM64_VERSION}}' url='{{ARM64_URL}}' sha256='{{ARM64_SHA256}}'
else
  version='{{X64_VERSION}}' url='{{X64_URL}}' sha256='{{X64_SHA256}}'
fi
[[ -n $url ]] || fail '暂时没有适用于这台 Mac 的版本。' 'No version is available for this Mac yet.'

installed=''
[[ -d $TARGET ]] && installed=$(defaults read "$TARGET/Contents/Info" CFBundleShortVersionString 2>/dev/null)
if [[ -n $installed ]]; then
  say "已安装 $installed，将安装 $version / Installed: $installed, installing: $version"
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-install.XXXXXX") || fail '无法创建临时文件夹。' 'Could not create a temporary folder.'

step "下载 $version / Downloading $version"
curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$work/client.dmg" "$ORIGIN$url" \
  || fail '下载失败，请检查网络后重新运行这条命令。' 'The download failed. Check your connection and run the command again.'
actual=$(shasum -a 256 "$work/client.dmg" | awk '{print $1}')
[[ $actual == "$sha256" ]] || fail '下载的文件不完整，请重新运行这条命令。' 'The download is incomplete. Run the command again.'

mkdir "$work/volume"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -noverify -mountpoint "$work/volume" "$work/client.dmg" \
  || fail '无法打开下载的安装包。' 'Could not open the downloaded disk image.'
mounted="$work/volume"
source_app="$mounted/$APP_NAME.app"
[[ -d $source_app && $(defaults read "$source_app/Contents/Info" CFBundleIdentifier 2>/dev/null) == "$BUNDLE_ID" ]] \
  || fail '安装包里没有找到客户端。' 'The disk image does not contain the client.'

if pgrep -qx "$BINARY"; then
  step '关闭正在运行的客户端 / Quitting the running client'
  pkill -x "$BINARY"
  for attempt in {1..20}; do
    pgrep -qx "$BINARY" || break
    sleep 0.5
  done
  pkill -9 -x "$BINARY" 2>/dev/null
fi

step '需要管理员权限 / Administrator permission needed'
say '请输入这台 Mac 的开机密码（登录密码），然后按回车。'
say '输入时屏幕上不会显示任何字符，这是正常的。'
say 'Type the password you use to log in to this Mac, then press Return.'
say 'Nothing appears while you type; that is normal.'
print -r -- ""
sudo -v -p "    密码 / Password: " || fail \
  '没有获得管理员权限。需要管理员账户的密码，可以请这台 Mac 的管理员运行这条命令。' \
  'Administrator permission was not granted. Ask an administrator of this Mac to run the command.'

step "安装到「应用程序」/ Installing into Applications"
staging="/Applications/.$APP_NAME.app.installing"
sudo rm -rf "$staging"
sudo ditto "$source_app" "$staging" || { sudo rm -rf "$staging"; fail '复制客户端失败。' 'Could not copy the client.'; }
# Remove the quarantine flag Gatekeeper checks, and make the app yours so updates need no password.
sudo xattr -dr com.apple.quarantine "$staging" 2>/dev/null
sudo chown -R "$(id -un):$(id -gn)" "$staging"
hdiutil detach -quiet "$mounted" 2>/dev/null && mounted=''

if [[ -e $TARGET ]]; then
  if ! sudo mv "$TARGET" "$work/previous.app" 2>/dev/null; then
    sudo rm -rf "$staging"
    fail '无法替换已安装的客户端。请先在「访达」的「应用程序」中把 ShareCode Client 移到废纸篓，再重新运行这条命令。' \
      'Could not replace the installed client. Move ShareCode Client from Applications to the Trash in Finder, then run the command again.' \
      '（也可以在「系统设置 → 隐私与安全性 → App 管理」中允许「终端」，再重新运行。）' \
      '(Or allow Terminal in System Settings → Privacy & Security → App Management, then run it again.)'
  fi
fi
if ! sudo mv "$staging" "$TARGET"; then
  [[ -e $work/previous.app ]] && sudo mv "$work/previous.app" "$TARGET"
  sudo rm -rf "$staging"
  fail '安装失败，已保留原来的版本。' 'Installation failed; the previous version was kept.'
fi
sudo rm -rf "$work/previous.app"
# A copy downloaded earlier through a browser may still be marked anywhere inside.
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
sudo -k

step '打开客户端 / Opening the client'
open "$TARGET" || say '请在「应用程序」中打开 ShareCode Client。/ Open ShareCode Client from Applications.'

print -r -- ""
print -r -- "${green}${bold}安装完成 / Installed: ShareCode Client $version${reset}"
say '首次打开时，客户端会引导你开启「输入监控」和「屏幕录制」权限。'
say 'On first launch the client guides you through Input Monitoring and Screen Recording.'
say '客户端会自动更新；也可以随时重新运行这条命令来更新或修复安装。'
say 'The client updates itself; run this command again any time to update or repair it.'
print -r -- ""
