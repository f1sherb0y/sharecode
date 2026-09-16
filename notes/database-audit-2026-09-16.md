# Database audit — 2026-09-16

Reviewed every table, constraint and index against server queries. Read-only production metadata and EXPLAIN (ANALYZE, BUFFERS) on PostgreSQL 17.9. No user content exported. Table row counts below are estimates.

| Table | Rows / total size | Finding / action |
|---|---|---|
| DocumentUpdate | 395,060 / 198 MB | Largest cost. Existing (documentId, timestamp) supports replay, (documentId, seq) supports checkpoint recovery. Retain both and unique seq for durability. No new blob covering index: increases every edit's write/storage cost. |
| Document | 820 / 2.6 MB | Unique name (room ID) already supports upserts and restoration; FK cascades are indexed. |
| Room | 906 / 1 MB | Existing (isDeleted, createdAt DESC, id DESC) supports admin paging. Owner, pinned sorting and inactivity cleanup indexes match live queries. Status filter uses cleanup index. No new filter indexes justified at this size. |
| User | 24 / 96 kB | Username/email uniqueness supports login. Add partial active-user chronological index for bounded admin pages as accounts grow. Sequential scans are correct at today's size. |
| RoomParticipant | 995 / 552 kB | Unique (roomId,userId), userId and shareLinkId cover membership/revocation/FKs. Separate roomId is a possible redundant prefix; retain until longer usage measurements justify dropping. |
| RoomShareLink | 1,530 / 720 kB | Token unique, roomId/createdBy and partial unconsumed expiresAt indexes match access/cleanup. |
| GuestSession | 1,530 / 968 kB | Token unique, roomId/shareLinkId cover access and revocation. |
| AuditEvent | 39 / 112 kB | API uses username + id cursor; actorId index cannot serve that lookup. Add (username,id DESC). Existing action+id and PK support other filters. |
| RoomNote | 0 / 48 kB | (roomId,createdAt) fits room notes. |
| Notification | 0 / 48 kB | Current severity-first CASE sort differs from createdAt index, but table is empty/small. createdBy FK has no index; physical user deletion is not used (soft deletion), so no demonstrated need. Revisit for bulk retention/hard deletion. |
| NotificationRead | 6 / 64 kB | Unique (notificationId,userId) plus (userId,readAt) cover unread checks and both FK directions. |
| _sqlx_migrations | system | Keep SQLx-managed PK/checksums unchanged. |

## Changes

- Admin users and rooms are separate tabs; only active tab is fetched. SQL COUNT + LIMIT/OFFSET; default 25, maximum 100; stable createdAt/id order and bounded search input.
- Remove the admin room participant N+1 queries (unused by UI).
- Playback byte totals only aggregate explicitly requested page room IDs (maximum 100); empty IDs do not trigger global aggregation.
- New migration adds just two small indexes above with a 5-second lock acquisition timeout. It leaves historical indexes/data intact. If tables grow substantially before applying, prebuild indexes concurrently during a maintenance operation.

## Measured plans (single run, not a benchmark)

- Old all-room playback aggregate: scans 395,060 updates; 135.757 ms, 13,367 shared buffers hit/read.
- Latest 25 rooms aggregate: indexed room history lookups, 15,715 joined rows; 35.954 ms, 8,757 buffers. Cache warmth differs; these times must not be treated as a universal speedup ratio. A page containing a huge recording still costs more.
- 25-room list with owner join: chronological index + memoized owner PK lookups; 0.126 ms.
- Active room filter: existing cleanup index + sort of 9 rows; 0.132 ms.

## Deliberately deferred

- pg_trgm GIN substring indexes: useful at tens of thousands of rooms/accounts and selective searches of at least 3 characters. Not installed today; current search tables are small. Avoid unnecessary extension privileges, GIN writes, and indexes now. User email search uses COALESCE and would need a matching expression index. Short/CJK searches need separate measurement.
- Very deep OFFSET pages eventually need cursor pagination; current numbered-page UI uses offsets intentionally. Exact COUNT also scales with matched rows.
- Do not remove unique/PK indexes based on low pg_stat counters. Some enforce correctness, and stats cover a short interval.
- Room owner index and participant roomId prefix may be redundant, but smaller indexes can still be cheaper; measure long-term before dropping.
- Large playback sessions still download their full update stream. Incremental client reconstruction helps CPU; range API/checkpoints and explicit retention policies are the next storage/network improvements. Never silently delete or compact history, since it changes replay fidelity.
- Consider pg_stat_statements in a future scheduled restart to measure real workloads; not enabled or restarted during this audit.

Canvas uses the existing Yjs document/update/checkpoint pipeline and requires no per-pointer-event SQL table or new history index.
