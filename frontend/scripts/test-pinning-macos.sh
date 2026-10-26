#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../src-tauri-client"
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/sharecode-pinning-tests.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
# build.rs compiles the production Swift with -O in debug and release builds.
cargo run --locked --example pinning_probe -- --legacy > "$test_dir/legacy.log" 2>&1 || true
rg -q 'PROBE FAILED:.*unsupported_native_layout_or_already_observed' "$test_dir/legacy.log"
cargo run --locked --example pinning_probe -- "$@" > "$test_dir/staged.log" 2>&1
if ! rg -q 'PROBE PASSED:' "$test_dir/staged.log"; then
  cat "$test_dir/staged.log"
  exit 1
fi
echo 'Real Tauri/WebKit regression passed; old creation order reproduced the failure.'
