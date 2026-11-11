#!/usr/bin/env bash
# Checks that the Go server (server-go) and the Rust server (server-rs) accept
# each other's databases: each one migrates an empty disposable database, then
# the other one starts on it. Disposable local data only; needs Docker, psql
# and a built Rust debug binary (cargo build --manifest-path server-rs/Cargo.toml).
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"
exe=''; [[ "${OS:-}" == Windows_NT ]] && exe=.exe
rust_bin="$project_dir/server-rs/target/debug/sharecode-server$exe"
[[ -x "$rust_bin" ]] || { echo "Build the Rust server first: $rust_bin" >&2; exit 1; }
work_dir="$(mktemp -d /tmp/sharecode-interchange.XXXXXX)"
go_bin="$work_dir/sharecode-server$exe"
(cd server-go && go build -o "$go_bin" ./cmd/sharecode-server)
container="sharecode-interchange-$$"
pid=''
cleanup() {
  [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
  docker rm -fv "$container" >/dev/null 2>&1 || true
  echo "Logs: $work_dir"
}
trap cleanup EXIT
docker run -d --name "$container" -p 127.0.0.1:55471:5432 \
  -e POSTGRES_USER=interchange -e POSTGRES_PASSWORD=local_interchange -e POSTGRES_DB=postgres \
  postgres:17-alpine >/dev/null
export PGPASSWORD=local_interchange
sql() { psql -XAt -h 127.0.0.1 -p 55471 -U interchange -d "$1" -v ON_ERROR_STOP=1 -c "$2"; }
for i in {1..150}; do
  if sql postgres 'SELECT 1' >/dev/null 2>&1; then break; fi
  (( i < 150 )) || { echo 'Disposable PostgreSQL did not start' >&2; exit 1; }
  sleep 0.2
done

# run <binary> <database> <log>: starts the server, waits for /health, stops it.
run() {
  env DATABASE_URL="postgresql://interchange:local_interchange@127.0.0.1:55471/$2" \
    BIND_ADDRESS=127.0.0.1 PORT=55472 JWT_SECRET=local-interchange-key-not-production \
    ADMIN_USERNAME=audit_admin ADMIN_PASSWORD='LocalAudit#2026Strong' \
    ADMIN_EMAIL=audit@example.invalid FRONTEND_URL=http://127.0.0.1:55473 \
    APP_URL=http://127.0.0.1:55473 TRUSTED_PROXY_CIDRS='' \
    "$1" >"$work_dir/$3.log" 2>&1 &
  pid=$!
  for i in {1..300}; do
    if curl -fs http://127.0.0.1:55472/health >/dev/null 2>&1; then
      # The account the first server made must sign in on the second.
      curl -fs -X POST -H 'Content-Type: application/json' \
        -d '{"username":"audit_admin","password":"LocalAudit#2026Strong"}' \
        http://127.0.0.1:55472/api/auth/login | grep -q '"token"' || { echo "FAIL $3: login" >&2; exit 1; }
      kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; pid=''
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  echo "FAIL $3: the server did not start" >&2; tail -20 "$work_dir/$3.log" >&2; exit 1
}
migrations() { sql "$1" 'SELECT version, description, success, encode(checksum, $$hex$$) FROM _sqlx_migrations ORDER BY version'; }
schema() { docker exec "$container" pg_dump -U interchange --schema-only --no-owner "$1" | grep -v '^\\\(un\)\?restrict ' ; }

sql postgres 'CREATE DATABASE by_rust' >/dev/null
sql postgres 'CREATE DATABASE by_go' >/dev/null
run "$rust_bin" by_rust rust-migrates
run "$go_bin" by_go go-migrates
migrations by_rust >"$work_dir/by_rust.migrations"
migrations by_go >"$work_dir/by_go.migrations"
diff "$work_dir/by_rust.migrations" "$work_dir/by_go.migrations" || { echo 'FAIL: the migration records differ' >&2; exit 1; }
schema by_rust >"$work_dir/by_rust.schema"
schema by_go >"$work_dir/by_go.schema"
diff "$work_dir/by_rust.schema" "$work_dir/by_go.schema" >"$work_dir/schema.diff" || { echo 'FAIL: the schemas differ' >&2; head -40 "$work_dir/schema.diff" >&2; exit 1; }
echo "PASS same migration records ($(wc -l <"$work_dir/by_go.migrations" | tr -d ' ')) and same schema"
run "$go_bin" by_rust go-on-rust
echo 'PASS the Go server starts on a database the Rust server migrated'
run "$rust_bin" by_go rust-on-go
echo 'PASS the Rust server starts on a database the Go server migrated'
migrations by_rust | diff - "$work_dir/by_go.migrations" >/dev/null && migrations by_go | diff - "$work_dir/by_go.migrations" >/dev/null \
  || { echo 'FAIL: a second server changed the migration records' >&2; exit 1; }
echo 'PASS neither server reapplied or changed a migration'
