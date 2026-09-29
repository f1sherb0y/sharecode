# Connected + Saving diagnosis — 2026-09-20

User reports intermittent room disconnections followed by `Connected` + `Saving…`, resolved by page reload, after 22:00 Asia/Shanghai on September 19. This investigation reads production logs and injects faults only into a disposable local database/API and Chromium. The initial diagnosis below preceded the fix; implementation and verification are recorded in `reconnect-recovery-2026-09-20.md`. No production deployment is included in this follow-up.

## Primary reproduced defect: forced reconnect leaves two sync states inconsistent

The installed Hocuspocus provider's `HocuspocusProviderWebsocket.checkConnection()` directly calls the websocket layer's `onClose()` after three missed-close attempts (its half-open/WebKit workaround). This cleans up the socket and emits `status: disconnected`, but bypasses the provider-level close event that normally sets `provider.synced = false`.

`use-yjs-provider.ts` independently sets React `isSynced = false` on disconnect. On reconnect, the provider receives a valid SyncStep2, but its `synced` setter does nothing because the internal flag is already true. React never receives a new `synced` event.

Actual observed state after the forced reconnect:

- socket: connected; authenticated: true; protocol ready: true
- provider.synced: true; React isSynced: false
- local pending: false; server pending: false; storage failure: false
- UI: `ConnectedSaving…Can edit`

The same Y.Doc remains mounted. Waiting for recovery does not resolve the mismatch. Reload reconstructs both state machines and immediately returns to Saved. `canWrite` also depends on React isSynced, so this is not merely a label defect.

A diagnostic-only Vite transform adding `if (connection) connection.synced = false` on non-connected status makes the same forced-close scenario recover to Saved without reload and without replacing Y.Doc. Production source was not changed. This validates the cause and a minimal correction direction; a production fix should cover disconnect lifecycle, stale callbacks and regression tests.

## Additional independently reproduced recovery gaps

1. Drop exactly one `durability-ack` at the application receive boundary while continuing all heartbeats and other messages: local pending stays true, server pending false, UI stays Connected/Saving for at least 16 seconds. The active barrier has no timeout/retry, and suppresses subsequent barriers indefinitely. Ordinary reconnect clears the barrier and restores Saved. This is fault injection, not evidence that TCP randomly loses a frame or that this happened in the reported session. A fix must never clear pending edits without a valid persistence acknowledgement.
2. Expire a user's access JWT while refresh temporarily returns 503. The hook classifies authentication failure as permanent revocation and explicitly disconnects. Restore the refresh endpoint and successfully obtain a fresh JWT: `shouldConnect` stays false and `syncError` stays sessionExpired. Reload recovers. This normally differs from the user's Connected symptom. Actual permission revocation must remain terminal; expired credentials and transient refresh failure need separate handling.

## Production evidence and limits

Captured six-hour server logs at `/tmp/sharecode-reconnect-diagnosis/server.log` (local, not published). In the captured window after 22:00 (14:00 UTC), 74 socket openings, 73 closes and 19 initial authentications were logged; repeated unauthenticated short connections occurred roughly every two seconds. This is aggregate traffic, not attributed to the reporting user's browser. There were no WARN/ERROR or room-log-commit-failure records in the captured window.

API container has run since 2026-09-17 18:01 UTC with restart count 0 and no OOM kill. PostgreSQL is healthy with restart count 0. The preceding releases recreated only the frontend; these observations do not support a database write failure or API restart explanation.

Current logs do not record the reason for each socket close, client sync flags, barrier lifetime, or authentication-denial reason. They cannot establish why this user's original socket lost connectivity or prove which recovery branch occurred in production. The forced-close state mismatch is a deterministic local reproduction of the precise reported symptom.

## Original reproduction (historical)

The diagnostic harness asserted the old defects and has now been replaced by
`frontend/tests/reconnect-recovery.mjs`, which asserts recovery on all three engines.
The commands below describe the initial investigation only.

```sh
bash scripts/test-runner-local.sh tests/reconnect-diagnosis.mjs
DIAG_FIX_SYNC=1 bash scripts/test-runner-local.sh tests/reconnect-diagnosis.mjs
```

The second command applies only a test-server source transform, not a product edit. Both use real React hook/Hocuspocus/API/persistence with the disposable database runner. The script intentionally asserts the existing defects, records state, and verifies refresh actually obtained a fresh token. Convert these into recovery assertions when implementing the production fixes.

Artifacts: `/tmp/sharecode-reconnect-diagnosis/`, including original and candidate JSON states and runner logs. Each runner also prints its isolated API log directory. No production accounts, rooms or content were changed.
