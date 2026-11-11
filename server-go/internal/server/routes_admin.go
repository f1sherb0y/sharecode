package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Deln0r/ygo"
	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/admin/users", h(a.createUser))
		mux.HandleFunc("GET /api/admin/users", h(a.getAllUsers))
		mux.HandleFunc("PATCH /api/admin/users/{id}", h(a.updateUser))
		mux.HandleFunc("DELETE /api/admin/users/{id}", h(a.deleteUser))
		mux.HandleFunc("GET /api/admin/rooms", h(a.getAllRooms))
		mux.HandleFunc("DELETE /api/admin/rooms/{id}", h(a.adminDeleteRoom))
		mux.HandleFunc("GET /api/admin/storage/db-size", h(a.getDbStorageSize))
		mux.HandleFunc("GET /api/admin/storage/playback", h(a.getRoomPlaybackSizes))
		mux.HandleFunc("POST /api/admin/rooms/{id}/playback/compress", h(a.compressRoomPlayback))
	})
}

// AdminListQuery is the query string of the admin user and room lists.
type AdminListQuery struct {
	Page     *uint32
	PageSize *uint32
	Q        *string
	Role     *string
	Status   *string
	Language *string
	Owner    *string
}

// parseAdminListQuery is Query<AdminListQuery>: a missing key is None, a
// number that does not parse rejects the request.
func parseAdminListQuery(r *http.Request) (*AdminListQuery, error) {
	values := r.URL.Query()
	q := &AdminListQuery{}
	for key, target := range map[string]**uint32{"page": &q.Page, "pageSize": &q.PageSize} {
		if values.Has(key) {
			n, err := strconv.ParseUint(values.Get(key), 10, 32)
			if err != nil {
				return nil, queryRejection(err)
			}
			*target = ptr(uint32(n))
		}
	}
	for key, target := range map[string]**string{
		"q": &q.Q, "role": &q.Role, "status": &q.Status, "language": &q.Language, "owner": &q.Owner,
	} {
		if values.Has(key) {
			*target = ptr(values.Get(key))
		}
	}
	return q, nil
}

// pagination gives the LIMIT, the OFFSET and the paging block of a list of
// total rows.
func (q *AdminListQuery) pagination(total int64) (limit, offset int64, block map[string]any) {
	requested := uint32(25)
	if q.PageSize != nil {
		requested = *q.PageSize
	}
	size := int64(min(max(requested, 1), 100))
	pages := (total + size - 1) / size
	first := uint32(1)
	if q.Page != nil {
		first = *q.Page
	}
	page := min(int64(max(first, 1)), max(pages, 1))
	return size, (page - 1) * size, pagination(page, size, total, pages)
}

// searchPattern treats search text literally, including PostgreSQL LIKE
// metacharacters.
func searchPattern(value *string) string {
	text := ""
	if value != nil {
		text = strings.TrimSpace(*value)
	}
	if runes := []rune(text); len(runes) > 200 {
		text = string(runes[:200])
	}
	text = strings.ReplaceAll(text, `\`, `\\`)
	text = strings.ReplaceAll(text, `%`, `\%`)
	text = strings.ReplaceAll(text, `_`, `\_`)
	return "%" + text + "%"
}

// PlaybackSizesQuery is the query string of the playback sizes.
type PlaybackSizesQuery struct {
	RoomIDs *string
}

type DbSizeRow struct {
	Bytes  int64  `db:"bytes"`
	Pretty string `db:"pretty"`
}

type PlaybackSizeRow struct {
	ID          string     `db:"id"`
	Name        string     `db:"name"`
	IsEnded     bool       `db:"is_ended"`
	EndedAt     *time.Time `db:"ended_at"`
	UpdateCount int64      `db:"update_count"`
	Bytes       int64      `db:"bytes"`
}

type PlaybackUpdateRow struct {
	Update    []byte    `db:"update"`
	Timestamp time.Time `db:"timestamp"`
	UserID    *string   `db:"user_id"`
}

type adminRoomOwnerRow struct {
	OwnerID string `db:"owner_id"`
}

type RoomStatusRow struct {
	IsEnded   bool `db:"is_ended"`
	IsDeleted bool `db:"is_deleted"`
}

type CompressedBucket struct {
	Timestamp time.Time
	Update    []byte
	UserID    *string
}

// adminUserPublicRow is UserPublicRow as the queries here select it: they
// also return token_version, which sqlx ignores and pgx must be given a
// field for.
type adminUserPublicRow struct {
	ID           string    `db:"id"`
	Email        *string   `db:"email"`
	Username     string    `db:"username"`
	Color        string    `db:"color"`
	Role         string    `db:"role"`
	CreatedAt    time.Time `db:"created_at"`
	TokenVersion int64     `db:"token_version"`
	LastSeen     time.Time `db:"last_seen"`
}

// adminPayloadString is payload.get(key).and_then(|v| v.as_str()) on a JSON
// body of any shape.
func adminPayloadString(payload any, key string) (string, bool) {
	object, ok := payload.(map[string]any)
	if !ok {
		return "", false
	}
	value, ok := object[key].(string)
	return value, ok
}

// adminHashPassword hashes as the bcrypt crate does at cost 12: what is
// past 72 bytes is not part of the hash (Go's bcrypt refuses it instead).
func adminHashPassword(password string) (string, error) {
	raw := []byte(password)
	if len(raw) > 72 {
		raw = raw[:72]
	}
	hashed, err := bcrypt.GenerateFromPassword(raw, 12)
	if err != nil {
		return "", internalError(fmt.Sprintf("Failed to hash password: %s", err))
	}
	return string(hashed), nil
}

func (a *App) createUser(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	var payload any
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()

	username, _ := adminPayloadString(payload, "username")
	password, _ := adminPayloadString(payload, "password")
	requestedRole, ok := adminPayloadString(payload, "role")
	if !ok {
		requestedRole = roleTech
	}

	if strings.TrimSpace(username) == "" || password == "" {
		return badRequest("Username and password are required")
	}
	username, ok = normalizeUsername(username)
	if !ok {
		return badRequest(invalidUsername)
	}

	if message := validatePassword(password); message != "" {
		return badRequest(message)
	}

	if !adminValidRole(requestedRole) {
		return badRequest("Invalid role")
	}

	deleted, err := usernameHolder(ctx, a.DB, username, nil)
	if err != nil {
		return err
	}
	if deleted != nil {
		if *deleted {
			return badRequest("This username belongs to a deleted account and is still reserved. Restore that account or choose another username.")
		}
		return badRequest("Username already taken")
	}

	hashedPassword, err := adminHashPassword(password)
	if err != nil {
		return err
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	user, err := queryOne[adminUserPublicRow](ctx, tx, `
        INSERT INTO "User" (id, username, password, color, role)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            email,
            username,
            color,
            role,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        `, uuid.NewString(), username, hashedPassword, randomUserColor(), requestedRole)
	if err != nil {
		return userCreationError(err)
	}

	if err := recordDetails(ctx, tx, client, "user.created", &authUser.ID, &authUser.Username, &user.ID, true, nil, nil,
		map[string]any{"role": user.Role}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("user created", "actor_id", authUser.ID, "actor_role", authUser.Role,
		"user_id", user.ID, "username", user.Username, "role", user.Role)

	writeJSON(w, http.StatusCreated, map[string]any{"user": userToJSON(&user)})
	return nil
}

// adminValidRole is VALID_ROLES.contains.
func adminValidRole(role string) bool {
	for _, valid := range validRoles {
		if valid == role {
			return true
		}
	}
	return false
}

func (a *App) getAllUsers(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.adminUser(r); err != nil {
		return err
	}
	query, err := parseAdminListQuery(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	pattern := searchPattern(query.Q)
	role := query.Role
	if role != nil && *role == "all" {
		role = nil
	}
	if role != nil && !adminValidRole(*role) {
		return badRequest("Invalid role")
	}
	total, err := scalar[int64](ctx, a.DB, `SELECT COUNT(*) FROM "User"
        WHERE "isDeleted" = false AND username ILIKE $1
        AND ($2::text IS NULL OR role = $2)`, pattern, role)
	if err != nil {
		return dbError(err, "Failed to count users")
	}
	limit, offset, block := query.pagination(total)
	users, err := queryAll[adminUserPublicRow](ctx, a.DB, `
        SELECT
            id,
            email,
            username,
            color,
            role,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE "isDeleted" = false
        AND username ILIKE $1
        AND ($2::text IS NULL OR role = $2)
        ORDER BY "createdAt" DESC, id DESC LIMIT $3 OFFSET $4
        `, pattern, role, limit, offset)
	if err != nil {
		return dbError(err, "Failed to load users")
	}

	list := make([]map[string]any, 0, len(users))
	for i := range users {
		list = append(list, userToJSON(&users[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"pagination": block, "users": list})
	return nil
}

func (a *App) updateUser(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	userID := r.PathValue("id")
	var payload any
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	// The role is the only account permission.
	requestedRole, ok := adminPayloadString(payload, "role")
	if !ok {
		return badRequest("Role is required")
	}
	if !adminValidRole(requestedRole) {
		return badRequest("Invalid role")
	}

	targetUser, err := queryOptional[UserRow](ctx, a.DB, `
        SELECT
            id,
            email,
            username,
            password,
            color,
            role,
            "isDeleted" as is_deleted,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE id = $1
        `, userID)
	if err != nil {
		return dbError(err, "Failed to load user")
	}
	if targetUser == nil || targetUser.IsDeleted {
		return notFound("User not found")
	}

	if targetUser.ID == authUser.ID && requestedRole != targetUser.Role {
		return notFound("Not found")
	}

	if targetUser.Role == roleAdmin && requestedRole != roleAdmin {
		adminCount, err := scalar[int64](ctx, a.DB, `SELECT COUNT(*) FROM "User" WHERE role = 'admin' AND "isDeleted" = false`)
		if err != nil {
			return dbError(err, "Failed to count admins")
		}
		if adminCount <= 1 {
			return notFound("Not found")
		}
	}

	// The owner's rank decides who else may see their private rooms.
	affectedPrivateRooms := []string{}
	if requestedRole != targetUser.Role {
		affectedPrivateRooms, err = scalars[string](ctx, a.DB,
			`SELECT id FROM "Room" WHERE "ownerId" = $1 AND "isPrivate" AND NOT "isDeleted"`, userID)
		if err != nil {
			return dbError(err, "Failed to load rooms affected by role change")
		}
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start user update")
	}
	defer tx.Rollback(context.Background())
	updated, err := queryOne[adminUserPublicRow](ctx, tx, `
        UPDATE "User"
        SET role = $2
        WHERE id = $1
        RETURNING
            id,
            email,
            username,
            color,
            role,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        `, userID, requestedRole)
	if err != nil {
		return dbError(err, "Failed to update user")
	}

	if err := recordDetails(ctx, tx, client, "user.permissions_changed", &authUser.ID, &authUser.Username, &userID, true, nil, nil,
		map[string]any{"before": map[string]any{"role": targetUser.Role}, "after": map[string]any{"role": updated.Role}}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit user update")
	}
	a.WS.RevokeActor(userID)

	for _, roomID := range affectedPrivateRooms {
		a.WS.RevokeInaccessibleRoom(ctx, roomID)
	}

	writeJSON(w, http.StatusOK, map[string]any{"user": userToJSON(&updated)})
	return nil
}

func (a *App) deleteUser(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	userID := r.PathValue("id")
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	user, err := queryOptional[UserRow](ctx, a.DB, `
        SELECT
            id,
            email,
            username,
            password,
            color,
            role,
            "isDeleted" as is_deleted,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        FROM "User"
        WHERE id = $1
        `, userID)
	if err != nil {
		return dbError(err, "Failed to load user")
	}
	if user == nil || user.IsDeleted {
		return notFound("User not found")
	}

	if user.ID == authUser.ID {
		return notFound("Not found")
	}

	if user.Role == roleAdmin {
		adminCount, err := scalar[int64](ctx, a.DB, `SELECT COUNT(*) FROM "User" WHERE role = 'admin' AND "isDeleted" = false`)
		if err != nil {
			return dbError(err, "Failed to count admins")
		}
		if adminCount <= 1 {
			return notFound("Not found")
		}
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start user update")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `
        UPDATE "User"
        SET "isDeleted" = true, "tokenVersion" = "tokenVersion" + 1
        WHERE id = $1
        `, userID); err != nil {
		return dbError(err, "Failed to delete user")
	}
	// Their busy time goes with them; their sessions still to come go back to
	// the unassigned list.
	if _, err := tx.Exec(ctx, `DELETE FROM "Appointment" WHERE "techId" = $1 AND "isBlock"`, userID); err != nil {
		return dbError(err, "Failed to remove busy time")
	}
	tag, err := tx.Exec(ctx, `UPDATE "Appointment" SET "techId" = NULL, "updatedAt" = NOW()
        WHERE "techId" = $1 AND "startsAt" + "durationMinutes" * INTERVAL '1 minute' > NOW()`, userID)
	if err != nil {
		return dbError(err, "Failed to unassign sessions")
	}
	unassignedSessions := tag.RowsAffected()

	slog.Info("user deleted", "actor_id", authUser.ID, "actor_role", authUser.Role,
		"user_id", user.ID, "username", user.Username, "target_role", user.Role, "deletion_mode", "soft")

	if err := recordDetails(ctx, tx, client, "user.deleted", &authUser.ID, &authUser.Username, &userID, true, nil, nil,
		map[string]any{"unassignedSessions": unassignedSessions}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit user update")
	}
	a.WS.RevokeActor(userID)

	writeJSON(w, http.StatusOK, map[string]any{"message": "User deleted successfully"})
	return nil
}

func (a *App) getAllRooms(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	query, err := parseAdminListQuery(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	pattern := searchPattern(query.Q)
	owner := searchPattern(query.Owner)
	language := query.Language
	if language != nil && *language == "all" {
		language = nil
	}
	var ended *bool
	switch {
	case query.Status == nil || *query.Status == "all":
	case *query.Status == "active":
		ended = ptr(false)
	case *query.Status == "ended":
		ended = ptr(true)
	default:
		return badRequest("Invalid room status")
	}
	filter := `FROM "Room" r JOIN "User" o ON o.id = r."ownerId"
        WHERE ` + roomVisibilitySQL + ` AND r.name ILIKE $4 AND o.username ILIKE $5
        AND ($6::text IS NULL OR r.language = $6) AND ($7::boolean IS NULL OR r."isEnded" = $7)`
	total, err := scalar[int64](ctx, a.DB, "SELECT COUNT(*) "+filter,
		authUser.ID, authUser.Role, hasGlobalRead(authUser), pattern, owner, language, ended)
	if err != nil {
		return dbError(err, "Failed to count rooms")
	}
	limit, offset, block := query.pagination(total)
	rooms, err := queryAll[RoomAdminRow](ctx, a.DB, `SELECT r.id, r.name, r.language, r.company, r.position,
        r."ownerId" as owner_id, r."isPrivate" as is_private, r."allowEdit" as allow_edit,
        r."isPinned" as is_pinned, r."isDeleted" as is_deleted,
        r."scheduledTime" as scheduled_time, r.duration, r."isEnded" as is_ended,
        r."endedAt" as ended_at, r."createdAt" as created_at, r."updatedAt" as updated_at,
        o.username as owner_username,
        `+roomPlaybackSQL+` as can_view_playback
        `+filter+` ORDER BY r."createdAt" DESC, r.id DESC LIMIT $8 OFFSET $9`,
		authUser.ID, authUser.Role, hasGlobalRead(authUser), pattern, owner, language, ended, limit, offset)
	if err != nil {
		return dbError(err, "Failed to load rooms")
	}

	response := make([]map[string]any, 0, len(rooms))
	for _, room := range rooms {
		response = append(response, map[string]any{
			"id":              room.ID,
			"name":            room.Name,
			"language":        room.Language,
			"company":         room.Company,
			"position":        room.Position,
			"ownerId":         room.OwnerID,
			"allowEdit":       room.AllowEdit,
			"isPrivate":       room.IsPrivate,
			"canViewPlayback": room.CanViewPlayback,
			"isPinned":        room.IsPinned,
			"isDeleted":       room.IsDeleted,
			"scheduledTime":   isoStringOpt(room.ScheduledTime),
			"duration":        room.Duration,
			"isEnded":         room.IsEnded,
			"endedAt":         isoStringOpt(room.EndedAt),
			"createdAt":       isoString(room.CreatedAt),
			"updatedAt":       isoString(room.UpdatedAt),
			"owner": map[string]any{
				"id":       room.OwnerID,
				"username": room.OwnerUsername,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"rooms": response, "pagination": block})
	return nil
}

func (a *App) getDbStorageSize(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.adminUser(r); err != nil {
		return err
	}
	size, err := queryOne[DbSizeRow](r.Context(), a.DB, `
        SELECT
            pg_database_size(current_database())::bigint as bytes,
            pg_size_pretty(pg_database_size(current_database())) as pretty
        `)
	if err != nil {
		return dbError(err, "Failed to load database size")
	}

	writeJSON(w, http.StatusOK, map[string]any{"bytes": size.Bytes, "pretty": size.Pretty})
	return nil
}

func (a *App) getRoomPlaybackSizes(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	query := PlaybackSizesQuery{}
	if values := r.URL.Query(); values.Has("roomIds") {
		query.RoomIDs = ptr(values.Get("roomIds"))
	}
	ids := []string{}
	if query.RoomIDs != nil {
		for _, id := range strings.Split(*query.RoomIDs, ",") {
			if id != "" {
				ids = append(ids, id)
			}
		}
	}
	invalid := len(ids) > 100
	for _, id := range ids {
		if _, err := uuid.Parse(id); err != nil {
			invalid = true
		}
	}
	if invalid {
		return badRequest("Provide at most 100 valid room IDs")
	}
	if len(ids) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"rooms": []any{}})
		return nil
	}
	rows, err := queryAll[PlaybackSizeRow](r.Context(), a.DB, `
        SELECT
            r.id,
            r.name,
            r."isEnded" as is_ended,
            r."endedAt" as ended_at,
            COUNT(du.id) as update_count,
            COALESCE(SUM(octet_length(du.update)), 0) as bytes
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        LEFT JOIN "DocumentUpdate" du ON du."documentId" = r.id
        WHERE `+roomVisibilitySQL+` AND r.id = ANY($4)
        GROUP BY r.id, r.name, r."isEnded", r."endedAt"
        ORDER BY bytes DESC
        `, authUser.ID, authUser.Role, hasGlobalRead(authUser), ids)
	if err != nil {
		return dbError(err, "Failed to load playback storage sizes")
	}

	response := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		response = append(response, map[string]any{
			"id":          row.ID,
			"name":        row.Name,
			"isEnded":     row.IsEnded,
			"endedAt":     isoStringOpt(row.EndedAt),
			"updateCount": row.UpdateCount,
			"bytes":       row.Bytes,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"rooms": response})
	return nil
}

// compressPlaybackBuckets is the grouping loop of compress_room_playback,
// statement for statement.
//
// It does what the Rust does, not what the Rust means to do: when a row of
// another second arrives, the Rust flushes what is pending and then sets
// current_bucket back to the bucket it just flushed (the inner
// `let bucket_time` shadows the row's). The current bucket is therefore the
// first row's second for the whole run: the rows of that second merge into
// one update, every later row whose second differs is flushed on its own,
// and every bucket carries the first second as its timestamp.
func compressPlaybackBuckets(updates []PlaybackUpdateRow) ([]CompressedBucket, error) {
	buckets := []CompressedBucket{}
	pending := []PlaybackUpdateRow{}
	var currentBucket *time.Time

	for _, row := range updates {
		bucketTime := row.Timestamp.Truncate(time.Second)
		if currentBucket == nil {
			currentBucket = &bucketTime
		}
		if !bucketTime.Equal(*currentBucket) {
			// server-rs set the current bucket back to the one it had just
			// closed here (a shadowed variable), so only the first second
			// was ever merged and every row was stamped with it. The
			// buckets are the seconds, as the code plainly means.
			merged, err := mergeBucketUpdates(pending)
			if err != nil {
				return nil, err
			}
			userID := mergeBucketUserID(pending)
			buckets = append(buckets, CompressedBucket{Timestamp: *currentBucket, Update: merged, UserID: userID})
			pending = pending[:0]
			currentBucket = &bucketTime
		}
		pending = append(pending, row)
	}

	if len(pending) != 0 {
		bucketTime := pending[0].Timestamp
		if currentBucket != nil {
			bucketTime = *currentBucket
		}
		merged, err := mergeBucketUpdates(pending)
		if err != nil {
			return nil, err
		}
		userID := mergeBucketUserID(pending)
		buckets = append(buckets, CompressedBucket{Timestamp: bucketTime, Update: merged, UserID: userID})
	}
	return buckets, nil
}

func (a *App) compressRoomPlayback(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("id")
	ctx := r.Context()

	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	room, err := queryOptional[RoomStatusRow](ctx, a.DB, `
        SELECT "isEnded" as is_ended, "isDeleted" as is_deleted
        FROM "Room"
        WHERE id = $1
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}
	if room == nil {
		return notFound("Room not found")
	}

	if room.IsDeleted {
		return notFound("Room not found")
	}

	if !room.IsEnded {
		return badRequest("Room has not ended yet")
	}

	if err := a.WS.WaitForSaved(ctx, roomID); err != nil {
		return err
	}
	updates, err := queryAll[PlaybackUpdateRow](ctx, a.DB, `
        SELECT update, timestamp, "userId" as user_id
        FROM "DocumentUpdate"
        WHERE "documentId" = $1
        ORDER BY timestamp ASC, seq ASC
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load playback updates")
	}

	originalCount := int64(len(updates))
	originalBytes := int64(0)
	for _, update := range updates {
		originalBytes += int64(len(update.Update))
	}

	if len(updates) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"roomId":            roomID,
			"originalUpdates":   originalCount,
			"compressedUpdates": 0,
			"originalBytes":     originalBytes,
			"compressedBytes":   0,
			"savedBytes":        0,
		})
		return nil
	}

	buckets, err := compressPlaybackBuckets(updates)
	if err != nil {
		return err
	}

	compressedCount := int64(len(buckets))
	compressedBytes := int64(0)
	for _, bucket := range buckets {
		compressedBytes += int64(len(bucket.Update))
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start compression transaction")
	}
	defer tx.Rollback(context.Background())

	if _, err := tx.Exec(ctx, `DELETE FROM "DocumentUpdate" WHERE "documentId" = $1`, roomID); err != nil {
		return dbError(err, "Failed to clear playback updates")
	}

	if len(buckets) != 0 {
		// One statement for every bucket, as sqlx's QueryBuilder::push_values
		// writes it.
		var builder strings.Builder
		builder.WriteString(`INSERT INTO "DocumentUpdate" (id, "documentId", update, "userId", timestamp) VALUES `)
		args := make([]any, 0, len(buckets)*5)
		for i, bucket := range buckets {
			if i > 0 {
				builder.WriteString(", ")
			}
			n := i * 5
			fmt.Fprintf(&builder, "($%d, $%d, $%d, $%d, $%d)", n+1, n+2, n+3, n+4, n+5)
			args = append(args, uuid.NewString(), roomID, bucket.Update, bucket.UserID, bucket.Timestamp)
		}
		if _, err := tx.Exec(ctx, builder.String(), args...); err != nil {
			return dbError(err, "Failed to insert compressed updates")
		}
	}

	if err := recordDetails(ctx, tx, client, "playback.compressed", &authUser.ID, &authUser.Username, &roomID, true, nil, &roomID,
		map[string]any{"originalUpdates": originalCount, "compressedUpdates": compressedCount,
			"originalBytes": originalBytes, "compressedBytes": compressedBytes}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit compression transaction")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"roomId":            roomID,
		"originalUpdates":   originalCount,
		"compressedUpdates": compressedCount,
		"originalBytes":     originalBytes,
		"compressedBytes":   compressedBytes,
		"savedBytes":        originalBytes - compressedBytes,
	})
	return nil
}

// adminDeleteRoom is admin::delete_room (DELETE /api/admin/rooms/{id}); the
// name deleteRoom belongs to rooms::delete_room.
func (a *App) adminDeleteRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("id")
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	room, err := queryOptional[adminRoomOwnerRow](ctx, a.DB, `
        SELECT "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
          AND "isDeleted" = false
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}
	if room == nil {
		return notFound("Room not found")
	}

	if !canDeleteRoom(authUser) {
		return notFound("Room not found")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `
        UPDATE "Room"
        SET "isDeleted" = true,
            "updatedAt" = NOW()
        WHERE id = $1
          AND "isDeleted" = false
        `, roomID); err != nil {
		return dbError(err, "Failed to delete room")
	}

	if err := recordDetails(ctx, tx, client, "room.deleted", &authUser.ID, &authUser.Username, &roomID, true, nil, &roomID,
		map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("room deleted", "actor_id", authUser.ID, "actor_role", authUser.Role, "room_id", roomID,
		"owner_id", room.OwnerID, "deletion_mode", "soft", "route", "admin.delete_room")

	a.WS.RevokeRoom(roomID)

	writeJSON(w, http.StatusOK, map[string]any{"message": "Room deleted successfully"})
	return nil
}

func mergeBucketUpdates(pending []PlaybackUpdateRow) ([]byte, error) {
	if len(pending) == 1 {
		return append([]byte(nil), pending[0].Update...), nil
	}

	raw := make([][]byte, 0, len(pending))
	for _, entry := range pending {
		raw = append(raw, entry.Update)
	}
	merged, err := ygo.MergeUpdates(raw)
	if err != nil {
		return nil, internalError(fmt.Sprintf("Failed to merge updates: %s", err))
	}
	return merged, nil
}

func mergeBucketUserID(pending []PlaybackUpdateRow) *string {
	var current *string
	for _, entry := range pending {
		switch {
		case current == nil && entry.UserID == nil:
		case current == nil:
			current = entry.UserID
		case entry.UserID != nil && *current == *entry.UserID:
		default:
			return nil
		}
	}
	if current == nil {
		return nil
	}
	return ptr(*current)
}

func userToJSON(user *adminUserPublicRow) map[string]any {
	return map[string]any{
		"id":        user.ID,
		"username":  user.Username,
		"color":     user.Color,
		"role":      user.Role,
		"createdAt": isoString(user.CreatedAt),
		"lastSeen":  isoString(user.LastSeen),
	}
}
