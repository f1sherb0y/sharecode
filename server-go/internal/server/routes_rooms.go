package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
)

func init() {
	registrars = append(registrars, registerRoomRoutes)
}

func registerRoomRoutes(a *App, mux *http.ServeMux) {
	mux.HandleFunc("GET /api/users", h(a.getAllUsersForRoomCreation))
	mux.HandleFunc("POST /api/rooms", h(a.createRoom))
	mux.HandleFunc("GET /api/rooms", h(a.getRooms))
	// axum routes /api/rooms/by-document/{documentId} ahead of
	// /api/rooms/{roomId}/notes and /share-links (a literal segment wins).
	// net/http refuses that pair of patterns as conflicting, so the route
	// is registered with a wildcard in place of "by-document" and checks
	// the segment itself.
	mux.HandleFunc("GET /api/rooms/{roomId}/{documentId}", h(a.getRoomByDocumentIDRoute))
	mux.HandleFunc("GET /api/rooms/{roomId}", h(a.getRoom))
	mux.HandleFunc("PUT /api/rooms/{roomId}", h(a.updateRoom))
	mux.HandleFunc("PUT /api/rooms/{roomId}/pin", h(a.setRoomPin))
	mux.HandleFunc("DELETE /api/rooms/{roomId}", h(a.deleteRoom))
	mux.HandleFunc("POST /api/rooms/{roomId}/end", h(a.endRoom))
}

// byDocumentSegment is the literal segment of /api/rooms/by-document/{documentId}.
const byDocumentSegment = "by-document"

// getRoomByDocumentIDRoute stands for the pattern
// GET /api/rooms/by-document/{documentId}: any other two-segment GET under
// /api/rooms that no pattern names is answered as the router would without
// this one.
func (a *App) getRoomByDocumentIDRoute(w http.ResponseWriter, r *http.Request) error {
	if r.PathValue("roomId") == byDocumentSegment {
		return a.getRoomByDocumentID(w, r)
	}
	switch r.PathValue("documentId") {
	case "pin":
		w.Header().Set("Allow", http.MethodPut)
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
	case "end":
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
	default:
		http.NotFound(w, r)
	}
	return nil
}

var supportedLanguages = [11]string{
	"javascript",
	"typescript",
	"python",
	"java",
	"c",
	"cpp",
	"rust",
	"go",
	"php",
	"markdown",
	"verilog",
}

func supportedLanguage(language string) bool {
	return slices.Contains(supportedLanguages[:], language)
}

type CreateRoomPayload struct {
	// IsPrivate is #[serde(default)] bool: absent is false, null is refused.
	IsPrivate     json.RawMessage `json:"isPrivate"`
	Name          *string         `json:"name"`
	Language      *string         `json:"language"`
	Company       *string         `json:"company"`
	Position      *string         `json:"position"`
	ScheduledTime *string         `json:"scheduledTime"`
	Duration      *int32          `json:"duration"`
	Timezone      *string         `json:"timezone"`
}

type UpdateRoomPayload struct {
	Name     *string `json:"name"`
	Language *string `json:"language"`
	Company  *string `json:"company"`
	Position *string `json:"position"`
}

type SetRoomPinPayload struct {
	IsPinned *bool `json:"isPinned"`
}

type RoomActivenessFilter string

const (
	RoomActivenessFilterAll    RoomActivenessFilter = "all"
	RoomActivenessFilterActive RoomActivenessFilter = "active"
	RoomActivenessFilterEnded  RoomActivenessFilter = "ended"
)

type GetRoomsQuery struct {
	Page       *uint32
	PageSize   *uint32
	OwnerID    *string
	Activeness *RoomActivenessFilter
}

// parseGetRoomsQuery is Query<GetRoomsQuery>: a missing key is None, a
// present one must parse, and a key given twice is refused.
func parseGetRoomsQuery(r *http.Request) (*GetRoomsQuery, error) {
	values := r.URL.Query()
	query := &GetRoomsQuery{}
	one := func(key string) (string, bool, error) {
		list, ok := values[key]
		if !ok {
			return "", false, nil
		}
		if len(list) > 1 {
			return "", false, queryRejection(fmt.Errorf("duplicate field `%s`", key))
		}
		return list[0], true, nil
	}
	number := func(key string) (*uint32, error) {
		raw, ok, err := one(key)
		if err != nil || !ok {
			return nil, err
		}
		// Rust's integer parsing takes one leading plus sign.
		digits := strings.TrimPrefix(raw, "+")
		if strings.HasPrefix(digits, "+") {
			digits = raw
		}
		n, err := strconv.ParseUint(digits, 10, 32)
		if err != nil {
			return nil, queryRejection(err)
		}
		return ptr(uint32(n)), nil
	}
	var err error
	if query.Page, err = number("page"); err != nil {
		return nil, err
	}
	if query.PageSize, err = number("pageSize"); err != nil {
		return nil, err
	}
	if raw, ok, err := one("ownerId"); err != nil {
		return nil, err
	} else if ok {
		query.OwnerID = &raw
	}
	if raw, ok, err := one("activeness"); err != nil {
		return nil, err
	} else if ok {
		switch filter := RoomActivenessFilter(raw); filter {
		case RoomActivenessFilterAll, RoomActivenessFilterActive, RoomActivenessFilterEnded:
			query.Activeness = &filter
		default:
			return nil, queryRejection(fmt.Errorf("unknown variant `%s`, expected one of `all`, `active`, `ended`", raw))
		}
	}
	return query, nil
}

type PaginationMeta struct {
	Page       uint32 `json:"page"`
	PageSize   uint32 `json:"pageSize"`
	Total      uint64 `json:"total"`
	TotalPages uint32 `json:"totalPages"`
	HasNext    bool   `json:"hasNext"`
	HasPrev    bool   `json:"hasPrev"`
}

// roomReturningSQL is the column list the room statements return.
const roomReturningSQL = `
            id,
            name,
            language,
            company,
            position,
            "ownerId" as owner_id,
            "isPrivate" as is_private,
            "allowEdit" as allow_edit,
            "isPinned" as is_pinned,
            "isDeleted" as is_deleted,
            "scheduledTime" as scheduled_time,
            duration,
            "isEnded" as is_ended,
            "endedAt" as ended_at,
            "createdAt" as created_at,
            "updatedAt" as updated_at,
            (SELECT username FROM "User" WHERE id = "ownerId") as owner_username,
            (SELECT color FROM "User" WHERE id = "ownerId") as owner_color
        `

// roomByIDSQL loads one room with its owner.
const roomByIDSQL = `
        SELECT
            r.id,
            r.name,
            r.language,
            r.company,
            r.position,
            r."ownerId" as owner_id,
            r."isPrivate" as is_private,
            r."allowEdit" as allow_edit,
            r."isPinned" as is_pinned,
            r."isDeleted" as is_deleted,
            r."scheduledTime" as scheduled_time,
            r.duration,
            r."isEnded" as is_ended,
            r."endedAt" as ended_at,
            r."createdAt" as created_at,
            r."updatedAt" as updated_at,
            o.username as owner_username,
            o.color as owner_color
        FROM "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        WHERE r.id = $1
        `

// getAllUsersForRoomCreation is GET /api/users. Techs never pick other
// accounts: they share rooms through links instead.
func (a *App) getAllUsersForRoomCreation(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.staffUser(r); err != nil {
		return err
	}
	users, err := queryAll[UserSimpleRow](r.Context(), a.DB, `
        SELECT id, username, color, role
        FROM "User"
        WHERE "isDeleted" = false AND NOT "linkOnly"
        ORDER BY username ASC
        `)
	if err != nil {
		return dbError(err, "Failed to load users")
	}
	response := make([]map[string]any, 0, len(users))
	for _, user := range users {
		response = append(response, map[string]any{
			"id":       user.ID,
			"username": user.Username,
			"color":    user.Color,
			"role":     user.Role,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": response})
	return nil
}

// createRoom is POST /api/rooms.
func (a *App) createRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	var payload CreateRoomPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	isPrivate := false
	if len(payload.IsPrivate) > 0 {
		var value *bool
		if err := json.Unmarshal(payload.IsPrivate, &value); err != nil || value == nil {
			return &plainError{http.StatusUnprocessableEntity,
				"Failed to deserialize the JSON body into the target type: isPrivate: invalid type, expected a boolean"}
		}
		isPrivate = *value
	}

	name := ""
	if payload.Name != nil {
		name = strings.TrimSpace(*payload.Name)
	}
	language := "javascript"
	if payload.Language != nil {
		language = *payload.Language
	}
	company := normalizeOptionalText(payload.Company)
	position := normalizeOptionalText(payload.Position)

	if name == "" {
		return badRequest("Room name is required")
	}

	if !supportedLanguage(language) {
		return badRequest("Unsupported language")
	}

	if isPrivate && !isAdmin(authUser.Role) {
		return forbidden("Only admins can create private rooms")
	}

	var scheduledTime *time.Time
	if payload.ScheduledTime != nil && *payload.ScheduledTime != "" {
		parsed, err := parseScheduledTime(*payload.ScheduledTime, payload.Timezone)
		if err != nil {
			return err
		}
		scheduledTime = &parsed
	}

	duration := payload.Duration
	if duration != nil && *duration == 0 {
		duration = nil
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to begin room transaction")
	}
	defer tx.Rollback(context.Background())

	room, err := insertRoom(ctx, tx, NewRoom{
		Name:          name,
		Language:      language,
		Company:       company,
		Position:      position,
		OwnerID:       authUser.ID,
		ScheduledTime: scheduledTime,
		Duration:      duration,
		IsPrivate:     isPrivate,
	})
	if err != nil {
		return err
	}
	roomID := room.ID

	if err := recordDetails(ctx, tx, client, "room.created", &authUser.ID, &authUser.Username, &roomID, true, nil, &roomID,
		map[string]any{"isPrivate": isPrivate, "language": language}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit room transaction")
	}

	slog.Info("room created",
		"actor_id", authUser.ID,
		"actor_role", authUser.Role,
		"room_id", room.ID,
		"room_name", room.Name,
		"language", room.Language,
	)

	writeJSON(w, http.StatusCreated, map[string]any{"room": roomToJsonOwner(room)})
	return nil
}

type NewRoom struct {
	Name          string
	Language      string
	Company       *string
	Position      *string
	OwnerID       string
	ScheduledTime *time.Time
	Duration      *int32
	IsPrivate     bool
}

// insertRoom inserts a room with its owner's membership inside the caller's
// transaction.
func insertRoom(ctx context.Context, tx DBTX, room NewRoom) (*RoomWithOwnerRow, error) {
	var scheduledTime *time.Time
	if room.ScheduledTime != nil {
		// Timestamp columns take the wall clock of the value: always UTC.
		scheduledTime = ptr(room.ScheduledTime.UTC())
	}
	created, err := queryOne[RoomWithOwnerRow](ctx, tx, `
        INSERT INTO "Room" (id, name, language, company, position, "ownerId", "scheduledTime", duration, "updatedAt", "isPrivate")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)
        RETURNING`+roomReturningSQL,
		uuid.NewString(), room.Name, room.Language, room.Company, room.Position, room.OwnerID,
		scheduledTime, room.Duration, room.IsPrivate)
	if err != nil {
		return nil, dbError(err, "Failed to create room")
	}

	if _, err := tx.Exec(ctx, `
        INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit")
        VALUES ($1, $2, $3, true)
        `, uuid.NewString(), created.ID, room.OwnerID); err != nil {
		return nil, dbError(err, "Failed to add owner as participant")
	}
	return &created, nil
}

// roomIsExpired: a scheduled room whose time and duration have passed.
func roomIsExpired(room *RoomWithOwnerRow, now time.Time) bool {
	if room.ScheduledTime == nil || room.Duration == nil {
		return false
	}
	return room.ScheduledTime.Add(time.Duration(*room.Duration) * time.Minute).Before(now)
}

func findParticipant(participants []RoomParticipantWithUserRow, userID string) *RoomParticipantWithUserRow {
	for i := range participants {
		if participants[i].UserID == userID {
			return &participants[i]
		}
	}
	return nil
}

// getRooms is GET /api/rooms.
func (a *App) getRooms(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	query, err := parseGetRoomsQuery(r)
	if err != nil {
		return err
	}
	page := uint32(1)
	if query.Page != nil {
		page = max(*query.Page, 1)
	}
	pageSize := uint32(20)
	if query.PageSize != nil {
		pageSize = min(max(*query.PageSize, 1), 100)
	}
	// The product is u32 arithmetic in Rust, kept as such.
	offset := int64((page - 1) * pageSize)
	var ownerID *string
	if query.OwnerID != nil {
		if trimmed := strings.TrimSpace(*query.OwnerID); trimmed != "" {
			ownerID = &trimmed
		}
	}
	activeness := RoomActivenessFilterAll
	if query.Activeness != nil {
		activeness = *query.Activeness
	}
	activenessValue := string(activeness)

	ctx := r.Context()
	filter := `FROM "Room" r JOIN "User" o ON o.id = r."ownerId"
        WHERE ` + roomVisibilitySQL + `
        AND ($4::text IS NULL OR r."ownerId" = $4)
        AND ($5 = 'all' OR ($5 = 'active' AND NOT r."isEnded") OR ($5 = 'ended' AND r."isEnded"))`
	countSQL := "SELECT COUNT(*) " + filter
	totalCount, err := scalar[int64](ctx, a.DB, countSQL,
		authUser.ID, authUser.Role, hasGlobalRead(authUser), ownerID, activenessValue)
	if err != nil {
		return dbError(err, "Failed to count rooms")
	}
	sql := `SELECT r.id, r.name, r.language, r.company, r.position,
        r."ownerId" as owner_id, r."isPrivate" as is_private, r."allowEdit" as allow_edit,
        r."isPinned" as is_pinned, r."isDeleted" as is_deleted,
        r."scheduledTime" as scheduled_time, r.duration, r."isEnded" as is_ended,
        r."endedAt" as ended_at, r."createdAt" as created_at, r."updatedAt" as updated_at,
        o.username as owner_username, o.color as owner_color,
        ` + roomPlaybackSQL + ` as can_view_playback
        ` + filter + ` ORDER BY r."isPinned" DESC, r."createdAt" DESC, r.id DESC LIMIT $6 OFFSET $7`
	rooms, err := queryAll[RoomWithOwnerRow](ctx, a.DB, sql,
		authUser.ID, authUser.Role, hasGlobalRead(authUser), ownerID, activenessValue, int64(pageSize), offset)
	if err != nil {
		return dbError(err, "Failed to load rooms")
	}

	response := make([]map[string]any, 0, len(rooms))
	now := time.Now()

	roomIDs := make([]string, 0, len(rooms))
	for i := range rooms {
		roomIDs = append(roomIDs, rooms[i].ID)
	}
	participantsMap, err := a.fetchParticipantsBatch(ctx, roomIDs)
	if err != nil {
		return err
	}

	for i := range rooms {
		room := &rooms[i]
		participants := participantsMap[room.ID]
		delete(participantsMap, room.ID)
		userParticipant := findParticipant(participants, authUser.ID)
		isOwner := room.OwnerID == authUser.ID
		isMember := isOwner || userParticipant != nil
		canEdit := canEditRoom(authUser, room, userParticipant)

		isExpired := roomIsExpired(room, now)

		value := roomToJsonWithFlags(room, participants, isMember, isOwner, canEdit, isExpired)
		value["canViewPlayback"] = room.CanViewPlayback
		response = append(response, value)
	}

	total := uint64(max(totalCount, 0))
	var totalPages uint32
	if total != 0 {
		totalPages = uint32((total + uint64(pageSize) - 1) / uint64(pageSize))
	}
	pagination := PaginationMeta{
		Page:       page,
		PageSize:   pageSize,
		Total:      total,
		TotalPages: totalPages,
		HasNext:    totalPages > 0 && page < totalPages,
		HasPrev:    page > 1 && total > 0,
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"rooms":      response,
		"pagination": pagination,
	})
	return nil
}

// getRoom is GET /api/rooms/{roomId}.
func (a *App) getRoom(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	return a.getRoomFor(w, r, authUser, r.PathValue("roomId"))
}

// getRoomFor is the body of get_room, which get_room_by_document_id calls
// with its own path.
func (a *App) getRoomFor(w http.ResponseWriter, r *http.Request, authUser *AuthUser, roomID string) error {
	ctx := r.Context()
	access, err := requireRoomAccess(ctx, a.DB, authUser, roomID)
	if err != nil {
		return err
	}
	room, err := queryOptional[RoomWithOwnerRow](ctx, a.DB, roomByIDSQL, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}
	if room == nil {
		return notFound("Room not found")
	}

	participants, err := a.fetchParticipants(ctx, room.ID)
	if err != nil {
		return err
	}
	isOwner := room.OwnerID == authUser.ID
	userParticipant := findParticipant(participants, authUser.ID)
	isParticipant := userParticipant != nil
	canEdit := canEditRoom(authUser, room, userParticipant)

	roomValue := roomToJson(room, participants)
	roomValue["isMember"] = isOwner || isParticipant
	roomValue["isOwner"] = isOwner
	roomValue["canEdit"] = canEdit && !room.IsEnded
	roomValue["canViewPlayback"] = access.CanViewPlayback
	roomValue["canReadNotes"] = true
	roomValue["canWriteNotes"] = access.CanEdit
	// Compatibility for clients from before notes had separate capabilities.
	roomValue["canManageNotes"] = access.CanEdit

	writeJSON(w, http.StatusOK, map[string]any{"room": roomValue})
	return nil
}

// getRoomByDocumentID is GET /api/rooms/by-document/{documentId}.
func (a *App) getRoomByDocumentID(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	documentID := r.PathValue("documentId")
	if documentID == "" {
		return badRequest("Document ID is required")
	}
	return a.getRoomFor(w, r, authUser, documentID)
}

func stringPtrEqual(a, b *string) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// updateRoom is PUT /api/rooms/{roomId}.
func (a *App) updateRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	actor, err := a.authActor(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	var payload UpdateRoomPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()

	// Order setting updates with WebSocket authentication/reconnect snapshots.
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	languageOnly := payload.Language != nil &&
		payload.Name == nil &&
		payload.Company == nil &&
		payload.Position == nil
	if actor.User != nil {
		if _, err := requireRoomAccess(ctx, a.DB, actor.User, roomID); err != nil {
			return err
		}
	} else {
		// A share guest who can write to the live room switches its language, nothing else.
		canWrite, err := requireContentAccess(ctx, a.DB, actor, roomID)
		if err != nil {
			return err
		}
		if !canWrite || !languageOnly {
			return forbidden("Only people who can edit this room can change its language")
		}
	}
	room, err := queryOptional[RoomWithOwnerRow](ctx, a.DB, roomByIDSQL, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}
	if room == nil {
		return notFound("Room not found")
	}

	// Settings stay with the owner and staff; whoever edits the live room, a member or
	// share guest who joined through an editing link included, also switches its language.
	canEdit, canChangeSettings := true, false
	if actor.User != nil {
		participants, err := a.fetchParticipants(ctx, room.ID)
		if err != nil {
			return err
		}
		participant := findParticipant(participants, actor.User.ID)
		canEdit = canEditRoom(actor.User, room, participant)
		canChangeSettings = canManageRoom(actor.User, room.OwnerID)
	}
	canChangeLanguage := canChangeSettings || canEdit
	languagePermission := languageOnly && canChangeLanguage

	if !canEdit && !languagePermission {
		return notFound("Room not found")
	}

	if payload.Language != nil && !canChangeLanguage {
		return notFound("Room not found")
	}
	if payload.Language != nil {
		if !supportedLanguage(*payload.Language) {
			return badRequest("Unsupported language")
		}
	}
	languageRequested := payload.Language != nil
	renameRequested := payload.Name != nil
	if renameRequested && !canChangeSettings {
		return notFound("Room not found")
	}

	var name *string
	if payload.Name != nil {
		if trimmed := strings.TrimSpace(*payload.Name); trimmed != "" {
			name = &trimmed
		}
	}
	var language *string
	if payload.Language != nil && *payload.Language != "" && supportedLanguage(*payload.Language) {
		language = payload.Language
	}
	company := normalizeOptionalText(payload.Company)
	position := normalizeOptionalText(payload.Position)

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	updated, err := queryOne[RoomWithOwnerRow](ctx, tx, `
        UPDATE "Room"
        SET name = COALESCE($2, name),
            language = COALESCE($3, language),
            company = COALESCE($4, company),
            position = COALESCE($5, position),
            "updatedAt" = NOW()
        WHERE id = $1
        RETURNING`+roomReturningSQL, roomID, name, language, company, position)
	if err != nil {
		return dbError(err, "Failed to update room")
	}

	if err := recordDetails(ctx, tx, client, "room.updated", ptr(actor.ID()), ptr(actor.Username()), &roomID, true, nil, &roomID,
		map[string]any{
			"language":        map[string]any{"before": room.Language, "after": updated.Language},
			"nameChanged":     renameRequested,
			"companyChanged":  !stringPtrEqual(room.Company, updated.Company),
			"positionChanged": !stringPtrEqual(room.Position, updated.Position),
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	if languageRequested {
		a.WS.BroadcastRoomLanguage(roomID, updated.Language)
	}
	if actor.Guest != nil {
		// Guests get the room as the share link showed it, without its owner or schedule.
		writeJSON(w, http.StatusOK, map[string]any{"room": map[string]any{
			"id": updated.ID, "name": updated.Name, "language": updated.Language,
			"allowEdit": updated.AllowEdit, "isEnded": updated.IsEnded,
			"endedAt": isoStringOpt(updated.EndedAt),
		}})
		return nil
	}
	writeJSON(w, http.StatusOK, map[string]any{"room": roomToJsonOwner(&updated)})
	return nil
}

// setRoomPin is PUT /api/rooms/{roomId}/pin.
func (a *App) setRoomPin(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	var payload SetRoomPinPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := requireFields("isPinned", payload.IsPinned); err != nil {
		return err
	}
	isPinned := *payload.IsPinned
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	if roomID == "" {
		return badRequest("Room ID is required")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	room, err := queryOptional[RoomWithOwnerRow](ctx, tx, `
        UPDATE "Room"
        SET "isPinned" = $2,
            "updatedAt" = NOW()
        WHERE id = $1
          AND "isDeleted" = false
        RETURNING`+roomReturningSQL, roomID, isPinned)
	if err != nil {
		return dbError(err, "Failed to update room pin status")
	}
	if room == nil {
		return notFound("Room not found")
	}

	if err := recordDetails(ctx, tx, client, "room.pin_changed", &authUser.ID, &authUser.Username, &roomID, true, nil, &roomID,
		map[string]any{"isPinned": isPinned}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	// Techs who could only see the room because it was pinned lose access.
	if !isPinned {
		a.WS.RevokeInaccessibleRoom(ctx, roomID)
	}
	participants, err := a.fetchParticipants(ctx, room.ID)
	if err != nil {
		return err
	}
	userParticipant := findParticipant(participants, authUser.ID)
	isOwner := room.OwnerID == authUser.ID
	isMember := isOwner || userParticipant != nil
	canEdit := canEditRoom(authUser, room, userParticipant)

	isExpired := roomIsExpired(room, time.Now())

	writeJSON(w, http.StatusOK, map[string]any{
		"room": roomToJsonWithFlags(room, participants, isMember, isOwner, canEdit, isExpired),
	})
	return nil
}

// deleteRoom is DELETE /api/rooms/{roomId}.
func (a *App) deleteRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	room, err := requireRoomAccess(ctx, a.DB, authUser, roomID)
	if err != nil {
		return err
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
	slog.Info("room deleted",
		"actor_id", authUser.ID,
		"actor_role", authUser.Role,
		"room_id", roomID,
		"owner_id", room.OwnerID,
		"deletion_mode", "soft",
		"route", "rooms.delete_room",
	)

	a.WS.RevokeRoom(roomID)

	writeJSON(w, http.StatusOK, map[string]any{"message": "Room deleted"})
	return nil
}

// endRoom is POST /api/rooms/{roomId}/end.
func (a *App) endRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	ctx := r.Context()

	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	room, err := requireRoomAccess(ctx, a.DB, authUser, roomID)
	if err != nil {
		return err
	}
	if roomID == "" {
		return badRequest("Room ID is required")
	}

	if !canEndRoom(authUser, room.OwnerID) {
		return notFound("Room not found")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	updated, err := queryOne[RoomWithOwnerRow](ctx, tx, `
        UPDATE "Room"
        SET "isEnded" = true,
            "endedAt" = $2,
            "updatedAt" = NOW()
        WHERE id = $1
        RETURNING`+roomReturningSQL, roomID, time.Now().UTC())
	if err != nil {
		return dbError(err, "Failed to end room")
	}

	if err := recordDetails(ctx, tx, client, "room.ended", &authUser.ID, &authUser.Username, &roomID, true, nil, &roomID,
		map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("room ended",
		"actor_id", authUser.ID,
		"actor_role", authUser.Role,
		"room_id", updated.ID,
		"room_name", updated.Name,
		"owner_id", updated.OwnerID,
		"ended_at", updated.EndedAt,
		"route", "rooms.end_room",
	)

	if updated.EndedAt != nil {
		a.broadcastRoomEnded(ctx, roomID, *updated.EndedAt)
	}

	writeJSON(w, http.StatusOK, map[string]any{"room": roomToJsonBasic(&updated)})
	return nil
}

func (a *App) fetchParticipantsBatch(ctx context.Context, roomIDs []string) (map[string][]RoomParticipantWithUserRow, error) {
	out := map[string][]RoomParticipantWithUserRow{}
	if len(roomIDs) == 0 {
		return out, nil
	}

	participants, err := queryAll[RoomParticipantWithUserRow](ctx, a.DB, `
        SELECT
            rp.id,
            rp."roomId" as room_id,
            u.id as user_id,
            rp."canEdit" as can_edit,
            rp."canReplay" as can_replay,
            rp."shareLinkId" as share_link_id,
            rp."joinedAt" as joined_at,
            u.username as user_username,
            u.color as user_color
        FROM "RoomParticipant" rp
        JOIN "User" u ON u.id = rp."userId"
        WHERE rp."roomId" = ANY($1)
        `, roomIDs)
	if err != nil {
		return nil, dbError(err, "Failed to load participants batch")
	}

	for _, p := range participants {
		out[p.RoomID] = append(out[p.RoomID], p)
	}
	return out, nil
}

func (a *App) fetchParticipants(ctx context.Context, roomID string) ([]RoomParticipantWithUserRow, error) {
	participants, err := queryAll[RoomParticipantWithUserRow](ctx, a.DB, `
        SELECT
            rp.id,
            rp."roomId" as room_id,
            u.id as user_id,
            rp."canEdit" as can_edit,
            rp."canReplay" as can_replay,
            rp."shareLinkId" as share_link_id,
            rp."joinedAt" as joined_at,
            u.username as user_username,
            u.color as user_color
        FROM "RoomParticipant" rp
        JOIN "User" u ON u.id = rp."userId"
        WHERE rp."roomId" = $1
        `, roomID)
	if err != nil {
		return nil, dbError(err, "Failed to load participants")
	}
	return participants, nil
}

func roomToJsonBasic(room *RoomWithOwnerRow) map[string]any {
	return map[string]any{
		"id":            room.ID,
		"name":          room.Name,
		"language":      room.Language,
		"company":       room.Company,
		"position":      room.Position,
		"ownerId":       room.OwnerID,
		"allowEdit":     room.AllowEdit,
		"isPrivate":     room.IsPrivate,
		"isPinned":      room.IsPinned,
		"isDeleted":     room.IsDeleted,
		"scheduledTime": isoStringOpt(room.ScheduledTime),
		"duration":      room.Duration,
		"isEnded":       room.IsEnded,
		"endedAt":       isoStringOpt(room.EndedAt),
		"createdAt":     isoString(room.CreatedAt),
		"updatedAt":     isoString(room.UpdatedAt),
	}
}

func roomToJsonOwner(room *RoomWithOwnerRow) map[string]any {
	value := roomToJsonBasic(room)
	value["owner"] = map[string]any{
		"id":       room.OwnerID,
		"username": room.OwnerUsername,
		"color":    room.OwnerColor,
	}
	return value
}

func roomToJson(room *RoomWithOwnerRow, participants []RoomParticipantWithUserRow) map[string]any {
	value := roomToJsonOwner(room)
	list := make([]map[string]any, 0, len(participants))
	for _, p := range participants {
		list = append(list, map[string]any{
			"id":       p.ID,
			"roomId":   p.RoomID,
			"userId":   p.UserID,
			"canEdit":  p.CanEdit,
			"joinedAt": isoString(p.JoinedAt),
			"user": map[string]any{
				"id":       p.UserID,
				"username": p.UserUsername,
				"color":    p.UserColor,
			},
		})
	}
	value["participants"] = list
	return value
}

func roomToJsonWithFlags(room *RoomWithOwnerRow, participants []RoomParticipantWithUserRow, isMember, isOwner, canEdit, isExpired bool) map[string]any {
	value := roomToJson(room, participants)
	value["isMember"] = isMember
	value["isOwner"] = isOwner
	value["canEdit"] = canEdit && !room.IsEnded
	value["isExpired"] = isExpired
	return value
}

// parseScheduledTime reads a room's scheduled time: with an offset as it
// stands, without one in the given time zone (UTC when there is none, or
// when that local time does not exist or exists twice).
func parseScheduledTime(value string, timezone *string) (time.Time, error) {
	// If the string already contains timezone info, use it directly
	if parsed, ok := chronoParseRFC3339(value); ok {
		return parsed, nil
	}
	if fields, ok := chronoParse(value, "%Y-%m-%dT%H:%M:%S%:z"); ok && fields.hasOffset {
		if naive, ok := fields.naive(); ok && fields.offset > -86400 && fields.offset < 86400 {
			return naive.Add(-time.Duration(fields.offset) * time.Second), nil
		}
	}

	// Parse as naive datetime, then interpret in the given timezone
	var naive time.Time
	found := false
	for _, format := range []string{
		"%Y-%m-%dT%H:%M:%S",
		"%Y-%m-%dT%H:%M",
		"%Y-%m-%d %H:%M:%S",
		"%Y-%m-%d %H:%M",
	} {
		if fields, ok := chronoParse(value, format); ok {
			if naive, ok = fields.naive(); ok {
				found = true
				break
			}
		}
	}
	if !found {
		return time.Time{}, internalError("Internal server error")
	}

	loc := time.UTC
	if timezone != nil {
		if parsed, ok := parseTz(*timezone); ok {
			loc = parsed
		}
	}
	if single, ok := fromLocalDatetimeSingle(naive, loc); ok {
		return single, nil
	}
	return naive, nil
}

// parseTz is chrono-tz's FromStr: an IANA zone by its exact name.
func parseTz(name string) (*time.Location, bool) {
	// LoadLocation gives these two a meaning chrono-tz does not.
	if name == "" || name == "Local" {
		return nil, false
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, false
	}
	return loc, true
}

// fromLocalDatetimeSingle is tz.from_local_datetime(naive).single(): the
// instant whose wall clock in loc is naive (given as that wall clock in
// UTC), when there is exactly one.
func fromLocalDatetimeSingle(naive time.Time, loc *time.Location) (time.Time, bool) {
	var found []time.Time
	for _, around := range []time.Duration{-48 * time.Hour, 0, 48 * time.Hour} {
		_, offset := naive.Add(around).In(loc).Zone()
		candidate := naive.Add(-time.Duration(offset) * time.Second)
		if _, actual := candidate.In(loc).Zone(); actual != offset {
			continue
		}
		if !slices.ContainsFunc(found, candidate.Equal) {
			found = append(found, candidate)
		}
	}
	if len(found) != 1 {
		return time.Time{}, false
	}
	return found[0].UTC(), true
}

// --- chrono's parsers, as far as parse_scheduled_time uses them ---

type chronoFields struct {
	year                              int64
	month, day, hour, minute, second  int
	hasMonth, hasDay, hasHour, hasMin bool
	offset                            int
	hasOffset                         bool
}

// naive is the date and time of the fields as a UTC wall clock; false for
// a date or time that does not exist. A leap second (60) is the second
// after 59.
func (f chronoFields) naive() (time.Time, bool) {
	if !f.hasMonth || !f.hasDay || !f.hasHour || !f.hasMin {
		return time.Time{}, false
	}
	if f.year < -262143 || f.year > 262142 || f.month < 1 || f.month > 12 || f.day < 1 ||
		f.hour > 23 || f.minute > 59 || f.second > 60 {
		return time.Time{}, false
	}
	second, leap := f.second, time.Duration(0)
	if second == 60 {
		second, leap = 59, time.Second
	}
	t := time.Date(int(f.year), time.Month(f.month), f.day, f.hour, f.minute, second, 0, time.UTC)
	if t.Day() != f.day || int(t.Month()) != f.month {
		return time.Time{}, false
	}
	return t.Add(leap), true
}

// chronoNumber is scan::number with a minimum of one digit.
func chronoNumber(s string, maxDigits int) (rest string, n int64, ok bool) {
	i := 0
	for i < len(s) && i < maxDigits && s[i] >= '0' && s[i] <= '9' {
		if n > (1<<62)/10 {
			return "", 0, false
		}
		n = n*10 + int64(s[i]-'0')
		i++
	}
	if i == 0 {
		return "", 0, false
	}
	return s[i:], n, true
}

// chronoOffset is scan::timezone_offset as %:z calls it: a sign, two digits
// of hours, any colons and spaces, two digits of minutes.
func chronoOffset(s string, colon func(string) (string, bool), allowZulu bool) (rest string, seconds int, ok bool) {
	if allowZulu && s != "" && (s[0] == 'Z' || s[0] == 'z') {
		return s[1:], 0, true
	}
	negative := false
	switch {
	case strings.HasPrefix(s, "+"):
		s = s[1:]
	case strings.HasPrefix(s, "-"):
		s, negative = s[1:], true
	case strings.HasPrefix(s, "−"):
		s, negative = s[len("−"):], true
	default:
		return "", 0, false
	}
	digit := func(c byte) bool { return c >= '0' && c <= '9' }
	if len(s) < 2 || !digit(s[0]) || !digit(s[1]) {
		return "", 0, false
	}
	hours := int(s[0]-'0')*10 + int(s[1]-'0')
	s, ok = colon(s[2:])
	if !ok {
		return "", 0, false
	}
	if len(s) < 2 || s[0] < '0' || s[0] > '5' || !digit(s[1]) {
		return "", 0, false
	}
	minutes := int(s[0]-'0')*10 + int(s[1]-'0')
	seconds = hours*3600 + minutes*60
	if negative {
		seconds = -seconds
	}
	return s[2:], seconds, true
}

// chronoParse is parse_from_str for the items %Y %m %d %H %M %S %:z, spaces
// and literals: numbers take leading spaces and one or two digits (a year
// up to four, or any number after a sign), and the whole input must be used.
func chronoParse(s, format string) (chronoFields, bool) {
	var f chronoFields
	for i := 0; i < len(format); i++ {
		c := format[i]
		switch {
		case c == ' ':
			s = strings.TrimLeftFunc(s, unicode.IsSpace)
		case c != '%':
			if s == "" || s[0] != c {
				return f, false
			}
			s = s[1:]
		default:
			i++
			spec := format[i]
			if spec == ':' {
				i++
				colonOrSpace := func(s string) (string, bool) {
					return strings.TrimLeftFunc(s, func(c rune) bool { return c == ':' || unicode.IsSpace(c) }), true
				}
				rest, offset, ok := chronoOffset(strings.TrimLeftFunc(s, unicode.IsSpace), colonOrSpace, false)
				if !ok {
					return f, false
				}
				s, f.offset, f.hasOffset = rest, offset, true
				continue
			}
			s = strings.TrimLeftFunc(s, unicode.IsSpace)
			var n int64
			var ok bool
			if spec == 'Y' {
				switch {
				case strings.HasPrefix(s, "-"):
					s, n, ok = chronoNumber(s[1:], len(s))
					n = -n
				case strings.HasPrefix(s, "+"):
					s, n, ok = chronoNumber(s[1:], len(s))
				default:
					s, n, ok = chronoNumber(s, 4)
				}
				if !ok {
					return f, false
				}
				f.year = n
				continue
			}
			if s, n, ok = chronoNumber(s, 2); !ok {
				return f, false
			}
			switch spec {
			case 'm':
				f.month, f.hasMonth = int(n), true
			case 'd':
				f.day, f.hasDay = int(n), true
			case 'H':
				f.hour, f.hasHour = int(n), true
			case 'M':
				f.minute, f.hasMin = int(n), true
			case 'S':
				f.second = int(n)
			}
		}
	}
	if s != "" {
		return f, false
	}
	return f, true
}

// chronoParseRFC3339 is DateTime::parse_from_rfc3339: fixed-width fields,
// "T", "t" or a space between date and time, any number of fraction
// digits, and "Z", "z" or ±hh:mm.
func chronoParseRFC3339(s string) (time.Time, bool) {
	if len(s) < 19 {
		return time.Time{}, false
	}
	for i := 0; i < 19; i++ {
		c := s[i]
		switch i {
		case 4, 7:
			if c != '-' {
				return time.Time{}, false
			}
		case 10:
			if c != 'T' && c != 't' && c != ' ' {
				return time.Time{}, false
			}
		case 13, 16:
			if c != ':' {
				return time.Time{}, false
			}
		default:
			if c < '0' || c > '9' {
				return time.Time{}, false
			}
		}
	}
	two := func(i int) int { return int(s[i]-'0')*10 + int(s[i+1]-'0') }
	fields := chronoFields{
		year:  int64(two(0)*100 + two(2)),
		month: two(5), day: two(8), hour: two(11), minute: two(14), second: two(17),
		hasMonth: true, hasDay: true, hasHour: true, hasMin: true,
	}
	naive, ok := fields.naive()
	if !ok {
		return time.Time{}, false
	}
	rest := s[19:]
	if strings.HasPrefix(rest, ".") {
		digits := 0
		for 1+digits < len(rest) && rest[1+digits] >= '0' && rest[1+digits] <= '9' {
			digits++
		}
		if digits == 0 {
			return time.Time{}, false
		}
		nanos, _ := strconv.Atoi((rest[1:1+min(digits, 9)] + "000000000")[:9])
		naive = naive.Add(time.Duration(nanos))
		rest = rest[1+digits:]
	}
	colon := func(s string) (string, bool) {
		if !strings.HasPrefix(s, ":") {
			return "", false
		}
		return s[1:], true
	}
	rest, offset, ok := chronoOffset(rest, colon, true)
	if !ok || rest != "" || offset <= -86400 || offset >= 86400 {
		return time.Time{}, false
	}
	return naive.Add(-time.Duration(offset) * time.Second), true
}

func normalizeOptionalText(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
