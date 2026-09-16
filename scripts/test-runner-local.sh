#!/usr/bin/env bash
# Disposable database; never reads .env or touches the local development DB.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
work_dir="$(mktemp -d /tmp/sharecode-runner-tests.XXXXXX)"
container_name="sharecode-runner-test-$$"
api_pid=''
cleanup() {
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  docker rm -fv "$container_name" >/dev/null 2>&1 || true
  echo "Local test logs: $work_dir"
}
trap cleanup EXIT
if (echo >/dev/tcp/127.0.0.1/55460) >/dev/null 2>&1; then
  echo 'Local test API port 55460 is occupied' >&2; exit 1
fi
docker run -d --name "$container_name" -p 127.0.0.1:55459:5432 \
  -e POSTGRES_USER=runner_test -e POSTGRES_PASSWORD=local_runner_test \
  -e POSTGRES_DB=runner_test postgres:17-alpine >/dev/null
for i in {1..50}; do
  if docker exec "$container_name" pg_isready -h 127.0.0.1 -U runner_test >/dev/null; then break; fi
  sleep 0.2
done
cd "$project_dir"
cargo test --manifest-path server-rs/Cargo.toml --offline
cargo build --manifest-path server-rs/Cargo.toml --offline
env DATABASE_URL=postgresql://runner_test:local_runner_test@127.0.0.1:55459/runner_test \
  PISTON_URL="${PISTON_URL:-http://127.0.0.1:2000}" \
  BIND_ADDRESS=127.0.0.1 PORT=55460 JWT_SECRET=local-runner-test-key-not-production \
  ADMIN_USERNAME=audit_admin ADMIN_PASSWORD='LocalAudit#2026Strong' \
  ADMIN_EMAIL=audit@example.invalid FRONTEND_URL=http://127.0.0.1:55461 \
  APP_URL=http://127.0.0.1:55461 TRUSTED_PROXY_CIDRS='' \
  "$project_dir/server-rs/target/debug/sharecode-server" >"$work_dir/api.log" 2>&1 &
api_pid=$!
cd frontend
node --input-type=module <<'JS'
for(let i=0;i<100;i++) {
  try { if((await fetch('http://127.0.0.1:55460/health')).ok) process.exit(0) } catch {}
  await new Promise(r=>setTimeout(r,100))
}
throw Error('Local API not ready')
JS
case "${1:-tests/runner-permissions.mjs}" in
  tests/canvas-integration.ts) node --experimental-transform-types tests/canvas-integration.ts ;;
  tests/runner-permissions.mjs|tests/admin-pagination.mjs|tests/markdown-switch.mjs) node "${1:-tests/runner-permissions.mjs}" ;;
  *) echo 'Unknown local test suite' >&2; exit 2 ;;
esac
