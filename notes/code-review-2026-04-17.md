# ShareCode Code Review — 2026-04-17

Scope: full codebase (frontend + `server-rs`). Focus: Yjs/Monaco/tldraw integration
correctness against upstream references, then a broader sweep.

Upstream references consulted:
- y-monaco: https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js
- tldraw-yjs example (canonical): https://github.com/m8e/tldraw-yjs-example/blob/main/src/useYjsStore.ts
- tldraw sync docs: https://tldraw.dev/docs/sync
- Hocuspocus provider config: https://tiptap.dev/docs/hocuspocus/provider/configuration
- Hocuspocus provider events: https://tiptap.dev/docs/hocuspocus/provider/events

---

## 1. API-usage review (Yjs + Monaco + tldraw + Hocuspocus)

Overall the integrations are **largely idiomatic**. Divergences:

### 1a. `MonacoBinding` — `frontend/src/lib/monaco-binding.ts`

Close reimplementation of y-monaco, with these differences:

- **Echo-suppression via mutex instead of transaction origin.** Upstream does
  `doc.transact(fn, this)` and early-returns from the observer when
  `transaction.origin === this`. You use a synchronous `createMutex` (lines 20–31).
  Works because Yjs fires observers synchronously inside `transact`, but it's
  more fragile: any async boundary inside a `mux` callback would break it, and
  it also suppresses `beforeTransaction` for your own writes.
  **Recommendation:** switch to the origin-check pattern.

- **Awareness field name** is `'cursor'` (lines 302, 349); upstream uses
  `'selection'`. Cosmetic — no interop needed since the server is custom — but
  inconsistent with the Yjs ecosystem convention. The separate `'blink'` field
  set by `handleBlink` (editor.tsx:302) is fine.

- **EOL handling is correct**: `model.setEOL(LF)` at `use-monaco-editor.ts:82`
  before constructing the binding. ✓

- **Dispose order** matches upstream, and `setLocalStateField('cursor', null)`
  is called on destroy. ✓

### 1b. tldraw + Yjs sync — `frontend/src/hooks/use-tldraw-store.ts`

Closely follows the canonical example:
- `store.listen({ source: 'user', scope: 'document' })` — correct filter pair (line 156). ✓
- Remote apply uses `store.mergeRemoteChanges`, not `transact` (lines 185, 247). ✓
- Presence wiring via `createPresenceStateDerivation(userAtom, presenceId)(store)`
  with `presenceId = InstancePresenceRecordType.createId(clientId)` (line 203). ✓
- Self-presence filter `state.presence.id !== presenceId` (lines 229, 236). ✓

Issues:

- **Re-entrant `ydoc.transact` inside a Y.Map observer** (`handleYjsChange`,
  lines 191–196). Writes the normalized asset records back while inside the
  `yRecords.observe` callback. Yjs does allow nested transactions, and the
  `if (event.transaction.local) return` guard (line 162) catches the recursive
  fire, but it's non-obvious. Since `normalizeAssetRecord` only rewrites legacy
  `yjs:...` URLs, consider doing this lazily on seed only, or deferring via
  `queueMicrotask`.

- **Asset store contract is half-implemented.** tldraw's `TLAssetStore.upload`
  returns the URL to persist on the shape. Your `upload` stores a **data URL**
  in Yjs *and* returns that same data URL. So the `if (src.startsWith('yjs:'))`
  branches in `resolve` (line 56) and `normalizeAssetRecord` (line 127) are
  **dead code**. Either delete the `yjs:` branches, or actually store data in
  Yjs and persist a `yjs:<id>` token on the asset record (that's the whole
  point of a keyed asset store — otherwise assets duplicate into every remote
  peer as part of the record itself).

- **No `requestAnimationFrame` coalescing on presence updates** (line 206). The
  upstream example wraps `awareness.setLocalStateField('presence', ...)` in
  `requestAnimationFrame` to throttle pointer-move floods. Under heavy use this
  sends O(pointer-move-rate) awareness updates per user.

- **`@tldraw/state` direct dep** (package.json:34). It's a tldraw internal —
  prefer importing everything from `tldraw` to avoid version skew.

### 1c. Hocuspocus provider — `frontend/src/hooks/use-yjs-provider.ts`

- Lifecycle is correct: one provider per mount, `destroy()` on cleanup (line 68). ✓
- Stateless JSON protocol is correct. ✓
- **Minor leak:** `setProvider(null)` is never called in cleanup
  (lines 67–69). After teardown, React state still holds the destroyed
  provider until a new effect sets a new one. If `shouldConnectWs` flips to
  false (room ended), consumers like `useEditorAwareness` will keep reading
  `provider.awareness` from a destroyed instance. Fix: `setProvider(null)`
  before `destroy()` in the cleanup.
- Callback ref-indirection pattern for `onStatelessMessage` is correct. ✓

---

## 2. Backend issues (higher impact)

### 2a. 🔴 Permissions inconsistent between REST and WebSocket

`core/permissions.rs:82-87` — `has_global_write()` counts
`role == "admin" || "superuser"` as write-anywhere. REST endpoints
(`rooms.rs:447, 545, 622, 740`) use this. But `ws/auth.rs:85` computes:

```rust
let can_write_globally = row.can_write_all_rooms || row.can_delete_all_rooms;
```

Role is **not** considered. Consequences:

- An **admin with no explicit global flags** who tries to edit a room they
  don't own is `canEdit: true` per REST, but `read_only: true` over the WS.
  Silent read-only mode.
- The auto-participant insert (ws/auth.rs:110–125) uses the same narrowed
  `can_write_globally` for the `canEdit` column. On first connection the admin
  gets a `RoomParticipant` row with `canEdit=false` — sticking them as
  read-only on every subsequent connection even if you later fix the WS auth.

`is_privileged` at ws/auth.rs:86 correctly gates `is_ended` access using
`admin || superuser || can_read_globally`, consistent with `has_global_read`
on the REST side.

**Fix:** extract one shared helper (in `core/permissions.rs`) that both paths
call. Current duplication guarantees drift.

### 2b. 🔴 Room-ended rooms still accept writes over the open WS

`ws/handlers.rs:284 handle_update_message` doesn't re-check the room's
`is_ended` state. When `POST /api/rooms/:id/end` is called,
`broadcast_room_ended` sends a stateless message — but already-connected
clients remain authenticated with `read_only=false`, so a misbehaving
(or slow-to-react) client can keep applying updates that get persisted.
The `DocumentState` also stays in memory and pending updates keep flushing.

**Fix options** (pick one):
- Cache an `is_ended` atomic on `DocumentState`, flip it in
  `broadcast_room_ended`, check in `handle_update_message`.
- After broadcast, close every connection for that document.

### 2c. 🟡 Server echoes awareness/stateless back to sender

`handle_awareness` (ws/handlers.rs:362) and `handle_stateless`
(ws/handlers.rs:414) both do:

```rust
doc_state.broadcast(message, Some(connection_id)).await;   // to others — correct
let _ = outgoing.send(Message::Binary(... clone ...));     // to self — redundant
```

`broadcast` already excludes the sender, so the self-send double-delivers.
Awareness is idempotent so no visible bug, but the provider processes its
own state echo on every keystroke and stateless messages duplicate. Remove
the self-sends.

### 2d. 🟡 `schedule_snapshot` debounce loop is needlessly twisty

`ws/handlers.rs:554-609`. The `should_wait` branch acquires the lock,
checks elapsed, drops the lock, re-acquires to compute `sleep_for`, then
sleeps and `continue`s — three lock acquisitions per iteration.

Simpler equivalent:
```rust
loop {
    let elapsed = {
        let guard = snapshot.lock().await;
        guard.last_update.elapsed()
    };
    if elapsed < Duration::from_secs(1) {
        tokio::time::sleep(Duration::from_secs(1) - elapsed).await;
        continue;
    }
    if let Err(err) = store_document_state(&db, &document_name, &doc_state).await { ... }
    let mut guard = snapshot.lock().await;
    if guard.last_update.elapsed() >= Duration::from_secs(1) {
        guard.running = false;
        return;
    }
}
```

### 2e. 🟡 Pending-updates flush task runs forever on idle

`ws/handlers.rs:629-660 queue_update`. The spawned task uses
`tokio::time::interval(Duration::from_secs(1))` and ticks every second even
when the queue is empty, only exiting when
`pending.is_empty() && elapsed >= 1s`. The path should self-terminate, but
worth confirming under load that tasks don't accumulate (e.g. if
`last_update` keeps being bumped by still-running flushes).

### 2f. 🟢 Minor

- `strip_unsupported_params` (main.rs:98): `parsed.set_query(None)` is called
  in both branches; harmless.
- `bcrypt::hash(..., 10)` (routes/auth.rs:76) — cost 10 is below the 2025
  recommended minimum of 12.
- `random_slug(8)` for share-link tokens (share.rs:481): only 8 chars of
  `[a-zA-Z0-9]` ≈ 47 bits. Fine for short-lived invites; bump to 16 for a
  safety margin.
- `decode_frame` (ws/protocol.rs:20) has no upper bound on `document_name`
  length — trivial for a malicious client to send a huge header. Cap to
  e.g. 256 bytes.
- Dead `use yrs::encoding::write::Write as _;` at handlers.rs:10.

---

## 3. Frontend issues

### 3a. 🟡 Hook deps: `ymeta` effect in `editor.tsx`

editor.tsx:226-261 — `effectiveRoom` is in the deps; `handleMetaChange`
closes over `effectiveRoom?.language`. On every language tick the effect
re-runs, re-binding `ymeta.observe` / `unobserve`. Better: subscribe once,
keep `effectiveRoomRef` up to date via a ref.

### 3b. 🟡 `useEditorAwareness` re-triggers `scrollToUser` on every awareness tick

use-editor-awareness.ts:106 — `scrollToUser` is registered on awareness
`'change'`. Every remote keystroke then calls `revealPositionInCenter` and
`setPosition` on the following user, even if their cursor didn't move.
Should compare head position against last-known and only reveal when it
changed, or when it falls outside the viewport (like `CanvasView.applyFollow`
at canvas-view.tsx:56). Also `setPosition(position)` moves the *local*
caret every tick — probably unintended when following.

### 3c. 🟢 `ensureStyleElement` per-client CSS injection

monaco-binding.ts:84-126 creates one `<style>` per remote clientID. For
long-running rooms with reconnects (each reconnect gets a new clientID),
elements pile up until the client disconnects. `pruneStyleElements` runs on
every `rerenderDecorations` but only for clients still present in awareness.
If a peer silently drops off without an awareness removal, their style leaks
until the next full rerender. Minor.

### 3d. 🟢 `auth.ts` persists only the token

stores/auth.ts:92 persists just `token`; `initialize()` fetches the profile
on load. Good — but the app flashes Spinner for one request on every
navigation. Consider persisting a lightweight `actorType` too.

### 3e. 🟢 `any` and TS escape hatches

- `useEditorAwareness` props (`provider: any`, `ytext: any`)
- `useMonacoEditor` props (`ytext: any`, `provider: any`)
- `CanvasView` (`provider: any`)
- `useTldrawStore` (`(record as any).typeName`, etc.)

Replace with the typed surfaces (`Y.Text`, `HocuspocusProvider`, `Awareness`).

### 3f. 🟢 Dead code in `useTldrawStore`

- `isSyncedRef`'s only reader is line 292. Keeping it out of the effect deps
  is fine, but `provider.on('synced', ...)` already handles the not-yet-synced
  case. Simpler: always wait on the `'synced'` event.
- `normalizeAssetRecord` / the `yjs:` scheme — `upload` never produces a
  `yjs:` src, so unused.

### 3g. 🟢 API client reads `localStorage` directly

api/client.ts:63 reads `localStorage` on every request. `useAuthStore` also
tracks the token. Pick one source of truth.

---

## 4. Prioritized suggestions

### Fix now (correctness / security)

1. Unify admin/superuser permission logic between REST and WS
   (`has_global_write` / `has_global_read` vs. `ws/auth.rs`).
2. Reject WS writes after the room is ended (`handle_update_message`).
3. Remove the self-echo in `handle_awareness` and `handle_stateless`.
4. Set `provider` state to null in `useYjsProvider` cleanup.

### Polish (clarity / perf)

5. Switch `MonacoBinding` from mutex to transaction-`origin` check.
6. Wrap tldraw presence sync in `requestAnimationFrame`.
7. Gate `useEditorAwareness` scroll-to-user on actual head-position change.
8. Simplify `schedule_snapshot` loop.
9. Delete dead `yjs:` asset branches — or actually implement keyed asset
   storage.

### Hygiene

10. Drop `any` types for `Y.Text` / `HocuspocusProvider` / `Awareness`.
11. Bump bcrypt cost to 12, lengthen share-link slug to 16 chars, cap WS
    `document_name` length.
12. Remove `@tldraw/state` direct dep in favor of `tldraw` re-exports.
