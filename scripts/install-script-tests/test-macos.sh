#!/usr/bin/env bash
# The macOS install script's flow, in a throwaway Linux container: zsh runs it for real, while
# stand-ins replace the macOS tools (hdiutil, sudo, defaults, ditto, xattr, open, pgrep...) and
# log their calls. It checks fresh installs, updates, refusals and cleanup, not Gatekeeper, real
# disk images or permissions: run the command on a Mac for those (BUILD.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
template="$here/../../server-rs/src/routes/client_install"
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$here:/harness:ro" -v "$template:/template:ro" \
  alpine:3.20 sh -c 'apk add -q zsh >/dev/null && zsh -n /template/install.zsh && sh /harness/macos-scenarios.sh'
