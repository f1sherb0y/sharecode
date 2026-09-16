#!/usr/bin/env bash
# Creates disposable local data only. Never reads .env or connects to production.
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
pg_bin="${PG_BIN:-}"
if [[ -z "$pg_bin" ]]; then
  if command -v initdb >/dev/null; then pg_bin="$(dirname "$(command -v initdb)")";
  else
    for path in /usr/lib/postgresql/{18,17,16}/bin; do
      if [[ -x "$path/initdb" ]]; then pg_bin="$path"; break; fi
    done
  fi
fi
if [[ ! -x "$pg_bin/initdb" ]]; then
  echo 'Set PG_BIN to a local PostgreSQL server bin directory (initdb, pg_ctl, postgres).' >&2
  exit 1
fi
for port in 55439 55440 55441 55442 55443; do
  if (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1; then
    echo "Port $port is occupied. Refusing to attach to an existing service." >&2
    exit 1
  fi
done
work_dir="$(mktemp -d /tmp/sharecode-local-tests.XXXXXX)"
api_pid=''
web_pid=''
pg_started=false
cleanup() {
  [[ -z "$web_pid" ]] || kill "$web_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  if $pg_started; then "$pg_bin/pg_ctl" -D "$work_dir/pg" -m immediate stop >/dev/null; fi
  echo "Local test logs and disposable database: $work_dir"
}
trap cleanup EXIT
"$pg_bin/initdb" -D "$work_dir/pg" -A trust --no-locale -E UTF8 >"$work_dir/init.log"
"$pg_bin/pg_ctl" -D "$work_dir/pg" -l "$work_dir/postgres.log" -o '-h 127.0.0.1 -p 55439 -k /tmp' start
pg_started=true
createdb -h 127.0.0.1 -p 55439 sharecode_sync_test
cd "$project_dir"
cargo test --manifest-path server-rs/Cargo.toml --offline
cargo build --manifest-path server-rs/Cargo.toml --offline
env DATABASE_URL="postgresql://${USER}@127.0.0.1:55439/sharecode_sync_test" \
  BIND_ADDRESS=127.0.0.1 PORT=55440 JWT_SECRET=local-sync-test-key-not-production \
  ADMIN_USERNAME=audit_admin ADMIN_PASSWORD='LocalAudit#2026Strong' \
  ADMIN_EMAIL=audit@example.invalid FRONTEND_URL=http://127.0.0.1:55441 \
  APP_URL=http://127.0.0.1:55441 TRUSTED_PROXY_CIDRS='' \
  "$project_dir/server-rs/target/debug/sharecode-server" >"$work_dir/api.log" 2>&1 &
api_pid=$!
cd frontend
env VITE_API_URL=http://127.0.0.1:55440 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 55441 >"$work_dir/vite.log" 2>&1 &
web_pid=$!
node --input-type=module <<'JS'
for (const url of ['http://127.0.0.1:55440/health','http://127.0.0.1:55441']) {
  let ready=false
  for(let i=0;i<100;i++){try{if((await fetch(url)).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
  if(!ready)throw Error(`Local service not ready: ${url}`)
}
JS
bunx tsc --noEmit
node --test tests/collaboration.test.mjs tests/markdown-math.test.mjs
node tests/account-duplicates.mjs
node tests/sync-integration.mjs
node tests/markdown-integration.mjs
node tests/sync-faults.mjs
node tests/sync-recovery.mjs
node tests/security-presence.mjs
bun run build
