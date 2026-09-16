# Collaboration reliability changes — 2026-09-16

Local implementation only. No production deployment, account restoration, permission update, or production database migration was performed.

## Contract

- One active in-memory document per room per server process. Registration and retirement share a per-room slot; registry lock is never held while loading PostgreSQL. Live updates/handshakes serialize using the room gate. Each room owns an independent durable writer.
- Broadcast follows validated acceptance into a bounded queue. It **does not mean saved**. PostgreSQL commit precedes save acknowledgements. The frontend labels connection and save state separately.
- Batches: 20 ms window, up to 128 events / approximately 256 KiB. Room queue: 2,048 waiting events plus at most one 128-event batch, 8 MiB accepted update bytes total. Socket queue: 256 messages / 8 MiB, with a separate immediate-close signal. Inbound frames/messages: 2 MiB.
- Each accepted update retains actor, receive timestamp and connection ID. Database retries reuse the same event IDs. No merge across actors for storage. Snapshots are generated from a separate **committed-only** Y.Doc every 5 seconds while active; they never contain speculative live edits. Missing-dependency updates prevent advancing the checkpoint. Logs are not automatically removed.
- Recovery = checkpoint plus ordered log tail. Existing snapshots have checkpoint zero so history is replayed to repair old gaps. Checkpoint failure cannot discard the log. Playback waits for accepted edits to finish saving rather than presenting an incomplete tail as complete.
- Browser IndexedDB recovery entries are immutable, credential/server/room scoped. Concurrent/duplicated tabs cannot overwrite or clear each other's newer records. A durability barrier clears only the acknowledged local prefix. A transient profile/network error preserves credentials and retries. Browser storage failure blocks editing visibly; it is not reported as saved.
- PostgreSQL commit protects against application process crashes. Surviving loss of the database host still needs backups/replication. This remains a **single server instance** design: do not start concurrent writable sync server instances against the same rooms without an ownership/fencing design.

## Identity, permissions and presence

- Tokens use sessionStorage, not shared localStorage. Old shared login state is intentionally not migrated: users must sign in again/open an invitation. New tabs have independent sessions; browser “duplicate tab” can initially copy sessionStorage, but subsequent state is independent and room identity is still checked.
- URL, loaded room and provider identity must agree before connecting/editing. Editor and share routes remount on room/token changes; stale room requests are aborted.
- Signed-in invitations resolve the exact room. Existing members/global viewers do not consume the guest invitation; new members atomically claim it and receive membership tied to that invitation. Revoking it removes those memberships and immediately closes their connections. Explicit memberships/global rights remain independent.
- Consumed invitations remain visible so the owner can revoke them. Desktop sharing uses the server's configured public APP_URL, rather than tauri.localhost.
- Authorization mutations coordinate with incoming frames. Revoked connections are removed from the room before the mutation responds. Slow outbound queues cannot postpone server-side revocation. Messages already transmitted before revocation cannot be recalled.
- Admin global permission flags are authoritative; superusers retain implicit global rights. Connecting with global access no longer silently creates permanent per-room write membership. Old auto-created memberships cannot be distinguished from intentional memberships and are not deleted by migration; administrators must review them separately.
- Password changes atomically increment User.tokenVersion and replace the password. All old JWTs fail REST and WebSocket authentication; established sockets are closed. The requesting tab receives a new token. Concurrent password changes use compare-and-swap. Existing zero-version JWTs work until a password change or ordinary expiry.
- Online roster is server-authoritative, based on authenticated connections rather than ephemeral cursor awareness. Native ping every 10 seconds; no pong for 45 seconds closes a dead socket. Idle connected users remain listed, closed/revoked connections disappear. Suspended devices that cannot maintain a network connection cannot truthfully remain “online.” Occupied rooms are excluded from the six-hour inactivity cleanup.

## Text and editors

- UTF-8 HTTP/JSON and PostgreSQL. Startup rejects a non-UTF-8 database. Yjs/Monaco/yrs positions use UTF-16 code units; Rust documents explicitly use OffsetKind::Utf16.
- New text uses LF. Existing CRLF, CR and leading BOM are projected consistently without read-only clients rewriting shared state. Offset mapping also covers selections/following.
- Unicode scalar values are preserved without NFC/NFKC or language conversion. Isolated UTF-16 surrogates, which cannot round-trip through UTF-8, become U+FFFD locally as on the wire. No GBK/Big5 decoder is guessed inside a shared document; a future file-import boundary must decode explicitly.
- Monaco undo/redo uses Y.UndoManager tracking only local binding origins. Remote changes do not pollute native offset-based undo history. Editors cannot undo while read-only.
- Rich text XML is Markdown's collaborative source of truth. It is not continuously mirrored into a second shared Y.Text. Playback reconstructs XML and serializes with the same schema; switching back to code takes an explicit local projection. Document changes remount the rich editor. Translation is disabled on editing surfaces.

## Audit and proxy configuration (required before a future deployment)

- AuditEvent records login success/failure, guest joins, invitation acceptance/revocation, user permission/deletion actions and password changes. Sensitive mutations and their audit records commit together. The audit API/page is administrator-only; records use cursor pagination. No endpoint can edit/delete audit records.
- Captures timestamp, actor/username, target, outcome, source IP, socket peer, source method, bounded User-Agent, generated request ID and a reason code. Never captures passwords, JWTs, authorization headers or request bodies. API traces use route templates instead of exposing share tokens in paths; malformed WS frames are not hex-dumped.
- TRUSTED_PROXY_CIDRS defaults empty. With no configured trust, record the socket IP and ignore forwarding headers. With explicitly trusted proxy peers, walk X-Forwarded-For right-to-left through the trusted suffix, stopping at the nearest untrusted hop. Invalid/oversized headers fall back to the socket peer. IPv4 and IPv6 are supported.
- The DMIT deployment has host Caddy → container Caddy → API. Before release, configure both Caddy trust chains and backend TRUSTED_PROXY_CIDRS for the actual proxy addresses/CIDRs. Do not trust every Internet address or blindly use the leftmost header. Both proxies must append/preserve a validated chain; remove custom X-Forwarded-For overrides that replace the original client with the proxy IP. The checked-in Caddyfile no longer has those overrides. Server-specific Caddyfile.production and live configuration were not edited.
- Without that deployment configuration the audit remains honest (socket/proxy address), but cannot reconstruct the original public client IP. Historical login IPs cannot be retroactively created by this feature. Audit is database-backed, not cryptographically tamper-proof against the database owner. No automatic audit retention/deletion is enabled.

## Local verification

Run `PG_BIN=/path/to/postgresql/bin scripts/test-collaboration-local.sh` from the repository root. Requires local PostgreSQL server binaries, Rust dependencies already cached, frontend dependencies and Playwright Chromium/Firefox. The runner refuses occupied ports 55439–55443, creates a fresh UTF-8 database under /tmp, uses explicit localhost URLs and test credentials, and stops its own services. It never reads production credentials. Logs and disposable data remain in the printed /tmp directory for inspection.

Tests cover real browser/editor bindings, undo after remote edits, CRLF/BOM, Unicode/emoji, local outbox versioning, simultaneous clients/room isolation, invitation navigation/revocation, mismatched guest rooms, Markdown mode transitions/playback, database lock/timeout/retry, multi-room workload, application SIGKILL plus browser reload, checkpoint-plus-tail recovery, idle presence beyond awareness timeout, old token rejection after password change, audit IP spoof resistance and audit page access.

Chromium/Firefox run on Linux. This is not a claim of Windows/macOS/iOS real-device or every IME validation. Test timing is a local debug-build observation, not a production throughput SLA. WebKit was not available in this environment.

### Completed clean-run result

On 2026-09-16 the isolated runner completed successfully against a newly initialized PostgreSQL 18.6 UTF-8 database: 10 Rust tests, 11 Chromium/Firefox and math regression tests, all five integration scripts (sharing/sync, Markdown, database faults, crash recovery, security/presence), TypeScript checking and the production frontend build. The runner shut down its own server, frontend and database afterwards. Logs: `/tmp/sharecode-final-validation.log`; isolated database/log directory: `/tmp/sharecode-local-tests.fKq8ge`.

Database-fault testing deliberately produces commit timeout errors followed by retries; these are expected. Vite still reports the existing large-bundle warning. Production PostgreSQL is 17; the SQL used is compatible with 17, but this run used 18.6 because those server binaries were available locally. Windows/macOS/iOS real-device validation remains outstanding.

## Authorized production release — 2026-09-16

The user subsequently authorized production deployment, proxy configuration, invalidating every existing manager token, and restoring all soft-deleted users. Release `20260916-security-093025` was deployed to DMIT on September 16, 2026; API maintenance ended at approximately 17:40 China time.

- Immutable images: `sharecode-server:20260916-security-093025`, `sharecode-frontend:20260916-security-093025`. Source manifest covers 148 files, including the final deletion tokenVersion increment. Both artifacts were built remotely, and PostgreSQL 17 migration/auth/audit smoke tests ran against an isolated production-backup copy before switching.
- Restored 21 soft-deleted users, retaining passwords, roles and relationships; incremented their tokenVersion to reject historical tokens. Database and authenticated users API now show 23 active users, zero soft-deleted users. Manager tokenVersion incremented to 1; old REST and WebSocket authentication explicitly verified rejected. Password and role were not changed, so manager can log in again with the password.
- User deletion now increments tokenVersion in the same transaction as soft deletion and audit; connections are revoked. Local regression explicitly confirms old tokens remain invalid even after the record is restored.
- Inner Caddy trusts only 172.18.0.1/32 with strict right-to-left XFF parsing. Its network address is fixed to 172.18.0.5 in the production Compose configuration. Backend TRUSTED_PROXY_CIDRS is 172.18.0.5/32,172.18.0.1/32. Host Caddy retains its existing first-hop default of ignoring untrusted forwarding headers. Removed inner header overrides that destroyed client IP/HTTPS information.
- Public normal and forged-XFF login probes both recorded the actual public egress address with `ipSource=trusted-proxy` and `peerIp=172.18.0.5`. These probes used a nonexistent username and appear as failed login audit entries. Read-only admin API verifies restored users; public Chromium login page loads without JavaScript errors. New backend logs showed zero ERROR/panic entries during verification.
- Only ShareCode server/frontend/Caddy containers were recreated. PostgreSQL, Piston and all unrelated application container IDs stayed unchanged. Temporary staging containers/database removed after verification. Production source directory synchronized to manifest to avoid a later rebuild reverting the fixes.
- Release files, verified manifest, account-operation audit and backups live at `/root/sharecode-releases/20260916-security-093025` on DMIT. `backup/database-at-cutover.dump` is the consistent cutover backup; `backup/database.dump` is the earlier backup. Old image tags retained. See `ROLLBACK.txt`: an old SQLx API binary cannot simply run against unknown new migration versions, and a database restore would undo later writes/account recovery. Prefer forward fixes; do not blindly restore.
- Browser sessions previously stored in shared localStorage are not migrated: refresh and sign in again/open the invitation. No claim of “no possible vulnerabilities” is made; real-device IME coverage and production load characterization remain as noted above.

### Follow-up: duplicate-account creation failure

At 17:43 China time the user deleted `manager` and attempted to create it again. Production logs showed the existence query `SELECT 1` decoded as Rust `i64`, whereas PostgreSQL returns INT4. The query only failed when it actually found a row, so successful new-account tests had missed it. Patched admin creation and public registration to decode the boolean `isDeleted` column; admin errors distinguish active duplicates from names/emails reserved by deleted accounts. Known unique-constraint races also map to a client error. No automatic reactivation, identity merging, permission inheritance or username reassignment is performed. Added `account-duplicates.mjs` coverage for active/deleted names and emails, registration and concurrent creation.
