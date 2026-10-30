#!/bin/sh
# Creates stand-ins for the macOS tools the install script uses; each logs to $LOG.
set -e
B=/stubs
mkdir -p $B
w() { printf '%s\n' '#!/bin/sh' "$2" > "$B/$1"; chmod +x "$B/$1"; }
w uname 'echo Darwin'
w sw_vers 'echo "${SW_VERS:-14.5}"'
w sysctl 'echo "${ARM:-1}"'
w shasum 'shift 2; sha256sum "$@"'
w curl 'echo "curl $*" >> $LOG; [ -n "$CURL_FAIL" ] && exit 22; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp /fixtures/client.dmg "$out"'
# hdiutil attach ... -mountpoint DIR FILE: puts the fixture app into DIR.
w hdiutil 'echo "hdiutil $*" >> $LOG; if [ "$1" = attach ]; then while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mp=$2; shift; done; cp -R /fixtures/volume/. "$mp/"; fi'
# defaults read <path>/Contents/Info KEY: KEY=value lines in Contents/Info.keys.
w defaults 'f="$2.keys"; [ -f "$f" ] || exit 1; v=$(grep "^$3=" "$f" | cut -d= -f2-); [ -n "$v" ] || exit 1; echo "$v"'
w pgrep 'echo "pgrep $*" >> $LOG; [ -f /tmp/running ]'
w pkill 'echo "pkill $*" >> $LOG; rm -f /tmp/running'
w ditto 'echo "ditto $*" >> $LOG; cp -R "$1" "$2"'
w xattr 'echo "xattr $*" >> $LOG'
w open 'echo "open $*" >> $LOG'
# sudo: -v asks for the password (SUDO_FAIL refuses); -k/-n pass; MV_FAIL refuses moving the installed app.
w sudo 'echo "sudo $*" >> $LOG
case "$1" in
  -v) printf "%s" "$3"; echo; [ -z "$SUDO_FAIL" ] || { echo "Sorry, user may not run sudo" >&2; exit 1; }; exit 0;;
  -k) exit 0;;
  -n) shift; exec "$@";;
esac
if [ -n "$MV_FAIL" ] && [ "$1" = mv ] && [ "$2" = "/Applications/ShareCode Client.app" ]; then echo "mv: Operation not permitted" >&2; exit 1; fi
exec "$@"'
