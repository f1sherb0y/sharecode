# Backend migration to Go — status

Written 2026-11-11, at commit `30c1848` on `feature/go-backend` (local only: not
pushed, not deployed). Update this file when one of the open items below closes.

## In one paragraph

The backend has been rewritten in Go (`server-go`) on the ygo fork
(`github.com/f1sherb0y/ygo`), and the local release gate passes against it. The
Rust server (`server-rs`) is still what production runs, and it is still in the
tree. Nothing about the database changes: either server starts on a database the
other one migrated.

## What exists

| | |
|---|---|
| Code | `server-go`: one package `internal/server` (`routes_*.go`, `ws_*.go`, `auth.go`, `permissions.go`, …), entry point `cmd/sharecode-server`, about 15,400 lines of Go against 12,800 of Rust, 50 unit tests |
| How it was carried over | Module by module; the rules are in `server-go/PORTING.md` |
| HTTP | `net/http` with `ServeMux` patterns |
| Database | pgx v5, plain SQL. Migrations are the same files as `server-rs/migrations`, embedded, and recorded in `_sqlx_migrations` the way sqlx records them (a test keeps the two directories byte-identical) |
| Sync | ygo `Doc` and `Awareness` behind the same Hocuspocus wire protocol, stateless messages, durable writer and close codes as before |
| ygo | Pinned in `go.mod` by a `replace` of `github.com/Deln0r/ygo` with the fork's merge commit `21fa47f` |
| Container | `server-go/Dockerfile`; `docker-compose.yml` builds it. The image builds; the binary in it is 14.2 MB |
| Tooling | `just server`, `just check`, `just test-server`, `just build-server` and `just install` use Go |

## What was verified, and where

All of this ran on one Windows 11 machine (24 threads, 16 GB), against disposable
PostgreSQL 17 containers.

- **The release gate** (`just predeploy`): all 17 steps pass against the Go server.
  Last run 387 s, four suites at a time.
- **Database interchange** (`scripts/test-server-interchange.sh`): each server
  migrates an empty database; the 29 migration records and the schemas are
  identical; each server then starts on the other's database, signs in the account
  the other one created, and changes no migration record.
- **Suites outside the gate**, run one at a time against Go: admin-pagination,
  audit-devices, share-links, markdown-switch, canvas-integration.
- **The collaboration suite** (`just test-integration`): passed against Go once,
  with the caveat under "Not verified".

## Not verified

- **macOS and Linux.** The Go server has only been run on Windows. The Docker image
  was built but no server was started from it.
- **Code execution** (`tests/runner-permissions.mjs`): needs Piston, not run.
- **Crash recovery with a Go restart.** When the collaboration suite passed,
  `tests/sync-recovery.mjs` restarted the server from the Rust binary. It now uses
  the binary under test (`SHARECODE_SERVER_BIN`); the suite has not been rerun since.
- **Production data.** No production database, session or account was used. The
  one production query made during this work was a read-only check for the
  playback bug below.
- **Load and long runs.** No soak test or capacity measurement of the Go server.
- **Like-for-like binary size.** No Rust release build was made to compare with.

## Known differences from the Rust server

- **Playback compression.** `server-rs` (`routes/admin.rs`, the loop that closes a
  bucket) stamps each bucket with the second of the row after it. The Go port
  stamps it with the second of its own rows. The Rust bug is not fixed in
  `server-rs`. Production had never used the feature when checked on 2026-11-11
  (no `playback.compressed` audit event, no room with the signature).
- **JSON field names** are matched without regard to case (`encoding/json`); serde
  matched them exactly. Requests the frontend sends are unaffected.
- **Request log lines** have Go's `slog` format, not `tracing`'s.

## Changes outside the server

- **The gate runs suites side by side.** `scripts/predeploy.sh` tests and builds the
  server once, then runs 13 suites four at a time (`SHARECODE_PREDEPLOY_JOBS`).
  Each suite with a server has its own database container and port block
  (`SHARECODE_TEST_PORT_BASE`, `frontend/tests/test-ports.mjs`). Every suite runs
  to its end and failures are listed together. Before: well over ten minutes, one
  suite at a time. Now: about six.
- **Eight at a time does not hold on this machine.** With the two fixes below in,
  eight still failed, each time on different suites, with 20–30 s page-load
  timeouts: every suite runs a Vite development server and the room page loads
  hundreds of unbundled Monaco modules. Serving the built bundle to the browser
  suites would be the way to go higher.
- **Frontend fix** (`src/lib/session-renewal.ts`): a refresh the server refused
  with 401 or 403 was asked again by every API call and poll with the same token.
  The refusal is now remembered for that token.
- **Test fixes**: `schedule.mjs` waits for the page's own "tour seen" request
  (WebKit on Windows sends it about a second late; the Rust server failed the same
  step) and starts the server under test for the inactivity sweep;
  `notes-permissions.mjs` lets a page finish loading before leaving it (Firefox
  reports the aborted lazy modules as a page error).

## Rust that remains

- `server-rs`: kept for reference and for `SHARECODE_SERVER=rust` comparison runs.
  Remove it once the Go server has run in production for a while.
- `frontend/src-tauri` (staff app) and `frontend/src-tauri-client` (customer
  client): Tauri, with Rust and Swift native code. The MyGo host replaces Tauri on
  Windows today and is not released (`notes/client-mygo-migration.md`); macOS
  support for it is planned (stated 2026-11-11, not started), which would retire
  the customer client's Rust on both platforms. The Swift code (capture, virtual
  display, pinning, permission guide) stays native either way; the Rust around it
  (`hotkey_macos.rs`, `main_window_macos.rs`, `screen_share_macos.rs`,
  `stealth_macos.rs`, `update_gate.rs`) is what a macOS MyGo host has to replace.

## Before deploying

1. Run the Go server on Linux: start the built image against a disposable
   database and run `just postdeploy` against it, or the gate on a Linux machine.
2. Rerun `just test-integration` (crash recovery with the Go binary) and, with
   Piston up, `tests/runner-permissions.mjs`.
3. Take a database backup. The switch itself is the `server` image only; the
   schema and the data stay as they are, and switching back to the Rust image
   needs no database change either.
4. `just predeploy` on the exact source, then deploy with the user's
   authorization, then `just postdeploy`.

## Uncommitted leftovers

`frontend/tests/ygo-backend.html`, `frontend/tests/ygo-backend.mjs` (the real
`useYjsProvider` hook against ygo's own e2e backend, from the fork work),
`notes/next-goal-ygo.md` and `tutorial-videos/` are untracked and were left alone.
