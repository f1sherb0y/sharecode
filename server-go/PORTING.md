# Porting server-rs to Go

`server-go` is `server-rs` in Go, on the same PostgreSQL schema, behind the
same frontend. The goal of every file is **the same behaviour**: the same
routes, status codes, JSON shapes, error messages, SQL, audit events and
side effects. The existing end-to-end tests (frontend/tests, run by
scripts/) are run against the Go binary unchanged; they are the judge.

Do not redesign, rename API fields, "improve" SQL, or drop a check because
it looks redundant. When Rust and a tidy Go idiom disagree, Rust wins.

## Layout

- `cmd/sharecode-server` — main.
- `internal/server` — one package, one Go file per Rust module:
  `server-rs/src/routes/rooms.rs` → `internal/server/routes_rooms.go`,
  tests in `routes_rooms_test.go`.
- `migrations/` — the SQL files (copies of server-rs/migrations).

Everything is in package `server`, so names are shared. **Name things after
the Rust item**: function `get_rooms` → method `(a *App) getRooms`; helper
`search_pattern` → `searchPattern`; type `AppointmentPayload` →
`AppointmentPayload` (keep the Rust type name; unexported types may be
lower-cased only if the Rust type is private *and* its name would clash).
If you need an item that lives in another Rust module being ported by
someone else (for example `super::rooms::…`), **call it by its ported name
and do not define it**; a build error "undefined: x" for such a name is
expected until that file lands. List those names in your final report.

## The core you build on (read these files first)

- `httpx.go`: `ApiError` and `badRequest/unauthorized/forbidden/notFound/
  conflict/gone/serviceUnavailable/internalError(msg)`; `handler` =
  `func(w, r) error`, wrapped with `h(...)`; `writeJSON(w, status, v)`;
  `readJSON(w, r, &v)` (axum `Json<T>`); `requireFields("name", ptr, …)` for
  JSON fields Rust declares without `Option` (decode them into pointers,
  then call it, so a missing field answers 422 as serde does);
  `isoString(t)`/`isoStringOpt(t)` (= `to_iso_string`, "+00:00");
  `Time` (a timestamp field Rust serializes directly with serde: "Z");
  `ptr(v)`.
- `db.go`: `DBTX` (pool, conn or tx); `dbError(err, "context")`;
  `queryAll[T]`, `queryOptional[T]` (nil = no row), `queryOne[T]`,
  `scalar[T]`, `scalarOptional[T]`, `scalars[T]`; `uniqueViolation(err)`,
  `pgErrorCode(err)`; `usernameHolder`, `userCreationError`.
  Row structs use `db:"column_alias"` tags exactly as the Rust query aliases
  them. Keep the SQL text as it is in Rust (same placeholders, same order).
- `auth.go`: extractors as methods: `a.authUser(r)`, `a.staffUser(r)`,
  `a.adminUser(r)`, `a.authActor(r)`; tokens: `generateUserToken`,
  `generateGuestToken`, `buildUserClaims`, `buildGuestClaims`,
  `verifyToken`, `verifyRefreshIdentity`, `extractBearerToken`.
- `sessions.go` (core/sessions.rs): `checkOrigin`, `checkCookieRequest`,
  `cookieHeader`, `cookieSecret`, `secretHash`, `createSession`,
  `loadSessionUser`, `sessionDays`.
- `permissions.go`: `isAdmin`, `isStaff`, `hasGlobalRead`, `validRoles`,
  `roomVisibilitySQL`, `roomPlaybackSQL`, `requireRoomAccess`,
  `requireContentAccess`, `canEditRoom`, `canEditRoomContent`,
  `canManageRoom`, `canEndRoom`, `canDeleteRoom`.
- `audit.go`: `a.clientInfo(r)` (the `ClientInfo` extractor), `record(...)`,
  `recordDetails(...)`, `identifyLoginDevice`, `pagination(...)`.
- `background.go`: `touchRoomActivity`, `guestShareTTLHours`,
  `roomInactivityTimeoutHours`.
- `utils.go`: `randomUserColor`, `validatePassword` (returns "" when fine),
  `passwordPolicyMessage`, `normalizeUsername`, `invalidUsername`.
- `models.go`: the rows of db/models.rs.
- `ws_state.go`: what routes call on the collaboration side:
  `a.WS.access` (the `RwLock`: `.write().await` → `a.WS.access.Lock()` +
  `defer Unlock()`, `.read().await` → `RLock`), `a.WS.OccupiedRooms()`,
  `RevokeShare`, `RevokeActor`, `RevokeSession`, `RevokeRoomActor`,
  `RevokeRoom`, `RevokeInaccessibleRoom(ctx, room)`, `WaitForSaved(ctx,
  room)`, `BroadcastRoomLanguage(room, language)`,
  `a.broadcastRoomEnded(ctx, roomID, endedAt)`.

## Rules of translation

**Routes.** Each file registers its own routes, with the paths from
`server-rs/src/routes/mod.rs`:

```go
func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/rooms/{roomId}", h(a.getRoom))
	})
}
```

Path parameters: `r.PathValue("roomId")`.

**Extractor order matters.** axum runs extractors in argument order and
answers with the first that fails. Call the Go equivalents in the same
order (for example `State, AuthUser, Path, Json` → `authUser` first, then
the path, then `readJSON`). A `Path<Uuid>`/number that does not parse and a
`Query<T>` that does not deserialize answer 400 with plain text: return
`queryRejection(err)` (audit.go) or a `&plainError{400, …}`.

**Query strings.** `Query<T>` with `Option` fields: a missing key is None;
a present key must parse or the request is rejected (400). serde does not
trim. Booleans are exactly `true`/`false`.

**JSON in.** serde ignores unknown fields; `Option<T>` → pointer;
`#[serde(default)]` → zero value; a required field → pointer +
`requireFields`. A wrong type (string for number) is a 422 from `readJSON`
already. Mind `Option<Option<T>>`/"double option" patterns (field absent vs
null): decode into `json.RawMessage` or a struct with a `Set bool` when the
Rust code tells them apart.

**JSON out.** Match field names (`rename_all = "camelCase"`), which fields
are omitted (`skip_serializing_if`) versus `null`, and number types. Empty
lists are `[]`, never `null` (`queryAll` already returns an empty slice;
initialise your own slices with `[]T{}`). `serde_json::json!` maps are
unordered for clients; a `map[string]any` is fine.

**Time.** `DateTime<Utc>` serialized by serde → `Time` ("…Z");
`to_iso_string(x)` → `isoString(x)` ("…+00:00"). Check each field: both
occur. Parsing: `DateTime<Utc>` from JSON/query is RFC 3339
(`time.Parse(time.RFC3339Nano, …)`). chrono-tz zones →
`time.LoadLocation` (tzdata is embedded in the binary).

**Transactions.** `state.db.begin()` → `tx, err := a.DB.Begin(ctx)`;
`defer tx.Rollback(context.Background())`; `tx.Commit(ctx)`. Keep
statement order and locking (`FOR UPDATE`, advisory locks) as in Rust.
`rows_affected()` → `tag.RowsAffected()`.

**Errors.** `.map_err(|e| db_error(e, "X"))?` → `return dbError(err, "X")`.
Keep every message string byte for byte, including the ones only logged.

**IDs and randomness.** `Uuid::new_v4().to_string()` → `uuid.NewString()`.
Random tokens: keep the alphabet and length; use `crypto/rand`.

**Passwords.** bcrypt: `golang.org/x/crypto/bcrypt`, same cost as Rust
uses at that call site.

**Concurrency.** `tokio::spawn` → goroutine. Do not hold `a.WS.access`
longer or shorter than Rust does.

**Tests.** Port the `#[cfg(test)]` tests of your modules to Go tests in the
matching `_test.go` file, same cases.

**Dependencies.** Standard library first. Already in go.mod: pgx/v5,
golang-jwt/jwt/v5, google/uuid, x/crypto, coder/websocket. If a module
needs one more (say so in the report), pick the standard, widely used one.

## Checking your work

```sh
cd server-go
gofmt -l internal/        # must print nothing for your files
go vet ./internal/server/ # only "undefined" for names owned by other files is acceptable
go test ./internal/server/ -run YourTests
```

Do not edit files you do not own (the core files above, other modules'
files). If the core lacks something you need, write it in your own file
with a clear name and say so in the report; if a core helper is wrong, say
so in the report instead of working around it silently.

Report at the end: files written, names you call that other files must
define, helpers you added, anything in the Rust you could not carry over
exactly and why, and anything suspicious you noticed in the Rust itself.
