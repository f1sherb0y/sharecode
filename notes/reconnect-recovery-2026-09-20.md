# Collaboration recovery fixes — 2026-09-20

Follow-up to `reconnect-diagnosis-2026-09-20.md`. These are local changes; no production deployment is part of this follow-up.

## Changes

- Reset both Hocuspocus and React authentication/sync flags on every disconnected/connecting status. The forced watchdog close can no longer leave React waiting for a sync event suppressed by the provider's stale `synced=true` flag.
- Reserve durability requests before awaiting IndexedDB, and discard work from a previous connection epoch. Retry the same request/version after five seconds; close the transport after a second timeout so normal reconnect performs a fresh handshake. Never acknowledge the local outbox on a timeout, and ignore stale request IDs. Read-only barriers never acknowledge pending writable edits.
- Distinguish expired user access credentials from definitive authentication/permission denials. Retry transient refresh failures with exponential backoff (one to thirty seconds), with online/visible wakeups. Wait for the old transport to close before reconnecting. Retain the document and editor during temporary failures; cancel recovery on unmount or denial. Guest credentials cannot enter user refresh recovery.
- Let recovery callers request refresh errors from the existing shared renewal operation while preserving background renewal behavior. Definitive HTTP 401/403 stops collaboration recovery.
- Patch Hocuspocus 3.4.4's queued reconnect callback to check `shouldConnect` again. A close handler can revoke access or destroy the provider after the retry was scheduled; that queued task must not reopen a connection. The patch covers source, ESM and CommonJS and is installed through Bun's existing patch mechanism.
- Saved status excludes terminal/local-storage errors; waiting for persistence tolerates a transient reconnect within its existing deadline.

## Regression coverage

`frontend/tests/reconnect-recovery.mjs` runs the real React hook, provider and Rust API against a disposable PostgreSQL database. Its Vite transform exposes state for assertions only; no candidate fix is injected. For Chromium, Firefox and WebKit it checks:

1. Three ordinary disconnects and two forced watchdog closes, with pending edits.
2. Missing durability acknowledgements: same-ID retry, timeout reconnect, preserved IndexedDB outbox, rejection of a stale acknowledgement after newer edits, and eventual outbox clearance.
3. Independent reconstruction of committed PostgreSQL update rows matches browser content.
4. Expired access credentials plus temporary refresh 503: automatic recovery without reloading or replacing the document/editor.
5. Actual server-side session revocation and refresh 401 remain terminal.
6. A delayed successful refresh after logout cannot restore the session or reopen its former provider.

The old fault-demonstration harness has been replaced with these recovery assertions. The new suite is included in `just predeploy`; the normal full gate remains mandatory before release.

## Validation

- `env -u ENGINE bash scripts/test-runner-local.sh tests/reconnect-recovery.mjs`: passed all eight scenarios in Chromium, Firefox and WebKit (24 scenario results). Includes 19 Rust unit tests. Browser state results: `/tmp/sharecode-reconnect-recovery/{chromium,firefox,webkit}.json`; runner/API logs: `/tmp/sharecode-runner-tests.XPnno1`; combined log: `/tmp/sharecode-recovery-all.log`.
- `bash scripts/test-runner-local.sh tests/session-renewal.mjs`: passed multi-device editing, in-place renewal, temporary database auth outage, renewal deduplication, guest isolation, actor-swap denial and password revocation; logs `/tmp/sharecode-recovery-session-renewal.log` and `/tmp/sharecode-runner-tests.UlHDGR`.
- `bun run build`: passed; log `/tmp/sharecode-reconnect-build.log` (existing bundle size warning).
- `bun install --frozen-lockfile`, shell/JavaScript syntax checks and `git diff --check`: passed.
- Injected transport failures can produce Vite proxy `ECONNRESET`/closed-socket diagnostics; every engine asserts zero browser page errors.
- Full `just predeploy` and deployment were not run for this local fix.
