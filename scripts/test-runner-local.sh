#!/usr/bin/env bash
# Disposable database; never reads .env or touches the local development DB.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
work_dir="$(mktemp -d /tmp/sharecode-runner-tests.XXXXXX)"
container_name="sharecode-runner-test-$$"
api_pid=''
# One block of local ports per run (database, API, the suite's web server, …);
# SHARECODE_TEST_PORT_BASE moves it so that suites can run side by side.
port_base="${SHARECODE_TEST_PORT_BASE:-55459}"
export SHARECODE_TEST_PORT_BASE="$port_base"
pg_port="$port_base"; api_port="$((port_base + 1))"; web_port="$((port_base + 2))"
# Suites without a Vite cache of their own must not share one while running together.
export SHARECODE_VITE_CACHE_DIR="${SHARECODE_VITE_CACHE_DIR:-node_modules/.vite-runner-$port_base}"
cleanup() {
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  docker rm -fv "$container_name" >/dev/null 2>&1 || true
  echo "Local test logs: $work_dir"
}
trap cleanup EXIT
if (echo >"/dev/tcp/127.0.0.1/$api_port") >/dev/null 2>&1; then
  echo "Local test API port $api_port is occupied" >&2; exit 1
fi
docker run -d --name "$container_name" -p "127.0.0.1:$pg_port:5432" \
  -e POSTGRES_USER=runner_test -e POSTGRES_PASSWORD=local_runner_test \
  -e POSTGRES_DB=runner_test postgres:17-alpine >/dev/null
for i in {1..50}; do
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U runner_test >/dev/null; then break; fi
  sleep 0.2
done
cd "$project_dir"
# The Go server (server-go) is the one under test; SHARECODE_SERVER=rust runs the
# same suite against the previous Rust server (server-rs) for comparison.
if [[ -n "${SHARECODE_SERVER_BIN:-}" && -x "$SHARECODE_SERVER_BIN" ]]; then
  # Built and tested once by the caller (scripts/predeploy.sh).
  server_bin="$SHARECODE_SERVER_BIN"
elif [[ "${SHARECODE_SERVER:-go}" == rust ]]; then
  cargo test --manifest-path server-rs/Cargo.toml --offline
  cargo build --manifest-path server-rs/Cargo.toml --offline
  server_bin="$project_dir/server-rs/target/debug/sharecode-server"
else
  exe=''; [[ "${OS:-}" == Windows_NT ]] && exe=.exe
  (cd server-go && go vet ./... && go test ./... && go build -o "$work_dir/sharecode-server$exe" ./cmd/sharecode-server)
  server_bin="$work_dir/sharecode-server$exe"
fi
# Tests that start a server of their own (restarts, the inactivity sweep) use the same binary.
export SHARECODE_SERVER_BIN="$server_bin"
# Client releases: files in the work directory, a throwaway update signing key (discarded)
# whose signatures tests/client-releases.mjs uploads, and the SHA-256 of its CI token
# (ci-test-token-not-a-secret).
env DATABASE_URL="postgresql://runner_test:local_runner_test@127.0.0.1:$pg_port/runner_test" \
  PISTON_URL="${PISTON_URL:-http://127.0.0.1:2000}" \
  BIND_ADDRESS=127.0.0.1 PORT="$api_port" JWT_SECRET=local-runner-test-key-not-production \
  ADMIN_USERNAME=audit_admin ADMIN_PASSWORD='LocalAudit#2026Strong' \
  ADMIN_EMAIL=audit@example.invalid FRONTEND_URL="http://127.0.0.1:$web_port" \
  APP_URL="http://127.0.0.1:$web_port" TRUSTED_PROXY_CIDRS='' \
  CLIENT_RELEASES_DIR="$work_dir/client-releases" \
  CLIENT_RELEASES_CI_TOKEN_SHA256=47a13613a90ad9136e0efbf02fc07b54e9d0de7e71e032673b610604ced19351 \
  CLIENT_UPDATER_PUBKEY=dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI4NEZDMzdBMzFFRjY0MkMKUldRc1pPOHhlc05QdUpFSVpoQ0R3NmVvbXNnRDZYWHBNUVJ5MjdFVTFza1BrbXRaNHV1aDQxdTYK \
  "$server_bin" >"$work_dir/api.log" 2>&1 &
api_pid=$!
export SHARECODE_TEST_CONTAINER="$container_name"
cd frontend
node --input-type=module <<'JS'
for(let i=0;i<100;i++) {
  try { if((await fetch(`http://127.0.0.1:${Number(process.env.SHARECODE_TEST_PORT_BASE) + 1}/health`)).ok) process.exit(0) } catch {}
  await new Promise(r=>setTimeout(r,100))
}
throw Error('Local API not ready')
JS
case "${1:-tests/runner-permissions.mjs}" in
  tests/canvas-integration.ts) node --experimental-transform-types tests/canvas-integration.ts ;;
  tests/runner-permissions.mjs|tests/admin-pagination.mjs|tests/markdown-switch.mjs|tests/share-links.mjs|tests/selection-blink.mjs|tests/role-permissions.mjs|tests/audit-devices.mjs|tests/session-renewal.mjs|tests/reconnect-recovery.mjs|tests/browser-sessions.mjs|tests/notes-permissions.mjs|tests/follow-permission.mjs|tests/schedule.mjs|tests/client-releases.mjs) node "${1:-tests/runner-permissions.mjs}" ;;
  *) echo 'Unknown local test suite' >&2; exit 2 ;;
esac
