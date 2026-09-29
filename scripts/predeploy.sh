#!/usr/bin/env bash
# Local release gate. Never uses production accounts or development database data.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
log_dir="${SHARECODE_PREDEPLOY_LOG_DIR:-$(mktemp -d /tmp/sharecode-predeploy.XXXXXX)}"
mkdir -p "$log_dir"
log_dir="$(cd "$log_dir" && pwd)"
printf 'Pre-deployment test logs: %s\n' "$log_dir"

for tool in docker cargo bun node; do
  command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker must be running.' >&2; exit 1; }
[[ -d frontend/node_modules ]] || { echo 'Run just install first.' >&2; exit 1; }

run_check() {
  local name="$1"
  shift
  printf 'Running %s…\n' "$name"
  if "$@" >"$log_dir/$name.log" 2>&1; then
    printf 'PASS %s\n' "$name" | tee -a "$log_dir/results.txt"
  else
    printf 'FAIL %s — deployment must stop.\n' "$name" | tee -a "$log_dir/results.txt" >&2
    tail -80 "$log_dir/$name.log" >&2
    exit 1
  fi
}

run_check diff git diff --check
run_check rust cargo test --manifest-path server-rs/Cargo.toml --offline
run_check build bash -c 'cd frontend && VITE_API_URL="" VITE_WS_URL="" VITE_ALLOW_REGISTRATION=false bun run build'
run_check browser-sessions env -u ENGINE bash scripts/test-runner-local.sh tests/browser-sessions.mjs
run_check session-renewal bash scripts/test-runner-local.sh tests/session-renewal.mjs
run_check reconnect-recovery env -u ENGINE bash scripts/test-runner-local.sh tests/reconnect-recovery.mjs
run_check notes-permissions bash scripts/test-runner-local.sh tests/notes-permissions.mjs
run_check follow-permission env -u ENGINE bash scripts/test-runner-local.sh tests/follow-permission.mjs
for engine in chromium firefox webkit; do
  run_check "workspace-$engine" env UI_BROWSER="$engine" bash -c 'cd frontend && node --test tests/workspace-ui.test.mjs'
done
run_check sarasa-fonts env -u ENGINE bash -c 'cd frontend && node tests/sarasa-font.mjs'
run_check session-export env -u ENGINE -u SESSION_EXPORT_DEV bash scripts/test-session-export.sh
printf 'All pre-deployment checks passed. Logs: %s\n' "$log_dir"
