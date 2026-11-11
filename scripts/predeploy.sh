#!/usr/bin/env bash
# Local release gate. Never uses production accounts or development database data.
#
# The server is tested and built once, then the suites run side by side, each on
# a disposable database and a port block of its own. SHARECODE_PREDEPLOY_JOBS sets
# how many run at once (default: a quarter of the processors, at most 4; 1 runs them one
# after another, as the gate used to).
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
log_dir="${SHARECODE_PREDEPLOY_LOG_DIR:-$(mktemp -d /tmp/sharecode-predeploy.XXXXXX)}"
mkdir -p "$log_dir"
log_dir="$(cd "$log_dir" && pwd)"
printf 'Pre-deployment test logs: %s\n' "$log_dir"
started=$SECONDS

for tool in docker go bun node; do
  command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'Docker must be running.' >&2; exit 1; }
[[ -d frontend/node_modules ]] || { echo 'Run just install first.' >&2; exit 1; }

# check <name> <command…>: runs one check into its log; the status says how it went.
check() {
  local name="$1" began=$SECONDS
  shift
  if "$@" >"$log_dir/$name.log" 2>&1; then
    printf 'PASS %s (%ss)\n' "$name" "$((SECONDS - began))" | tee -a "$log_dir/results.txt"
  else
    printf 'FAIL %s (%ss)\n' "$name" "$((SECONDS - began))" | tee -a "$log_dir/results.txt" >&2
    return 1
  fi
}
run_check() {
  printf 'Running %s…\n' "$1"
  check "$@" || { printf 'FAIL %s — deployment must stop.\n' "$1" >&2; tail -80 "$log_dir/$1.log" >&2; exit 1; }
}

# What everything else needs, in order: the source, the server (tested and built
# once; every suite starts this binary), the production bundle.
run_check diff git diff --check
run_check server bash -c 'cd server-go && go vet ./... && go test ./...'
exe=''; [[ "${OS:-}" == Windows_NT ]] && exe=.exe
export SHARECODE_SERVER_BIN="$log_dir/sharecode-server$exe"
run_check server-build bash -c 'cd server-go && go build -o "$SHARECODE_SERVER_BIN" ./cmd/sharecode-server'
run_check build bash -c 'cd frontend && VITE_API_URL="" VITE_WS_URL="" bun run build'

# The suites. Those with a server get a port block each (see tests/test-ports.mjs).
names=()
commands=()
suite() { names+=("$1"); shift; commands+=("$(printf '%q ' "$@")"); }
port_base=55500
server_suite() {
  local name="$1"
  shift
  suite "$name" env SHARECODE_TEST_PORT_BASE="$port_base" "$@"
  port_base=$((port_base + 10))
}
server_suite browser-sessions env -u ENGINE bash scripts/test-runner-local.sh tests/browser-sessions.mjs
server_suite session-renewal bash scripts/test-runner-local.sh tests/session-renewal.mjs
server_suite reconnect-recovery env -u ENGINE bash scripts/test-runner-local.sh tests/reconnect-recovery.mjs
server_suite role-permissions bash scripts/test-runner-local.sh tests/role-permissions.mjs
server_suite notes-permissions bash scripts/test-runner-local.sh tests/notes-permissions.mjs
server_suite schedule bash scripts/test-runner-local.sh tests/schedule.mjs
server_suite client-releases env -u ENGINE bash scripts/test-runner-local.sh tests/client-releases.mjs
server_suite follow-permission env -u ENGINE bash scripts/test-runner-local.sh tests/follow-permission.mjs
for engine in chromium firefox webkit; do
  suite "workspace-$engine" env UI_BROWSER="$engine" bash -c 'cd frontend && node --test tests/workspace-ui.test.mjs'
done
suite sarasa-fonts env -u ENGINE bash -c 'cd frontend && node tests/sarasa-font.mjs'
suite session-export env -u ENGINE -u SESSION_EXPORT_DEV bash scripts/test-session-export.sh

processors="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)"
# Four at a time passed on a 24-thread, 16 GB machine; at eight the suites that
# watch timing (reconnect-recovery, notes-permissions) failed under the load.
default_jobs=$((processors / 4)); ((default_jobs >= 1)) || default_jobs=1; ((default_jobs <= 4)) || default_jobs=4
jobs="${SHARECODE_PREDEPLOY_JOBS:-$default_jobs}"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || { echo 'SHARECODE_PREDEPLOY_JOBS must be a positive number.' >&2; exit 1; }
printf 'Running %s suites, %s at a time…\n' "${#names[@]}" "$jobs"

# Every suite runs to its end, so that one run names every failure.
running=0
failed=0
for i in "${!names[@]}"; do
  if ((running >= jobs)); then
    wait -n || failed=1
    running=$((running - 1))
  fi
  ( check "${names[$i]}" bash -c "${commands[$i]}" ) &
  running=$((running + 1))
done
while ((running > 0)); do
  wait -n || failed=1
  running=$((running - 1))
done

if ((failed)); then
  printf '\nDeployment must stop. Failed checks:\n' >&2
  grep '^FAIL ' "$log_dir/results.txt" | while read -r _ name _; do
    printf '\n── %s (%s) ──\n' "$name" "$log_dir/$name.log" >&2
    tail -40 "$log_dir/$name.log" >&2
  done
  exit 1
fi
printf 'All pre-deployment checks passed in %ss. Logs: %s\n' "$((SECONDS - started))" "$log_dir"
