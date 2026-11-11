package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/rooms/{roomId}/share-links", h(a.createShareLink))
		mux.HandleFunc("GET /api/rooms/{roomId}/share-links", h(a.listShareLinks))
		mux.HandleFunc("DELETE /api/rooms/{roomId}/share-links/{shareLinkId}", h(a.deleteShareLink))
		mux.HandleFunc("POST /api/share/{token}/join", h(a.joinShareLink))
		mux.HandleFunc("POST /api/share/{token}/accept", h(a.acceptShareLink))
	})
}

// shareRoomOwnerRow is share.rs's private RoomOwnerRow (routes/admin.rs has
// another of that name).
type shareRoomOwnerRow struct {
	ID        string `db:"id"`
	OwnerID   string `db:"owner_id"`
	IsDeleted bool   `db:"is_deleted"`
	IsEnded   bool   `db:"is_ended"`
	AllowEdit bool   `db:"allow_edit"`
}

type RoomOwnerOnlyRow struct {
	ID      string `db:"id"`
	OwnerID string `db:"owner_id"`
}

type ShareLinkOwnerRow struct {
	RoomID  string `db:"room_id"`
	OwnerID string `db:"owner_id"`
}

type ClaimedShareLinkRow struct {
	ID string `db:"id"`
}

type CreateShareLinkPayload struct {
	CanEdit *bool `json:"canEdit"`
}

type JoinSharePayload struct {
	Username *string `json:"username"`
}

func (a *App) createShareLink(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	var payload CreateShareLinkPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()
	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	room, err := queryOptional[shareRoomOwnerRow](ctx, a.DB, `
        SELECT id, "ownerId" as owner_id, "isDeleted" as is_deleted,
               "isEnded" as is_ended, "allowEdit" as allow_edit
        FROM "Room"
        WHERE id = $1
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}

	if room == nil || room.IsDeleted {
		return notFound("Room not found")
	}

	if !canManageRoomShares(authUser, room.OwnerID) {
		return notFound("Room not found")
	}

	if room.IsEnded {
		return badRequest("Cannot create share links for ended rooms")
	}

	token := randomSlug(16)
	canEdit := payload.CanEdit != nil && *payload.CanEdit && room.AllowEdit

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	// A session's room keeps its links valid until the session ends.
	shareLink, err := queryOne[ShareLinkSummaryRow](ctx, tx, `
        INSERT INTO "RoomShareLink" (id, "roomId", token, "canEdit", "createdBy", "expiresAt")
        VALUES ($1, $2, $3, $4, $5, GREATEST(
            NOW() + $6 * INTERVAL '1 hour',
            (SELECT MAX(a."startsAt" + a."durationMinutes" * INTERVAL '1 minute') FROM "Appointment" a
             WHERE a."roomId" = $2)
        ))
        RETURNING
            id,
            token,
            "canEdit" as can_edit,
            "createdAt" as created_at,
            "expiresAt" as expires_at,
            "consumedAt" as consumed_at,
            "roomId" as room_id,
            0::bigint as guest_count
        `, uuid.NewString(), room.ID, token, canEdit, authUser.ID, float64(guestShareTTLHours))
	if err != nil {
		return dbError(err, "Failed to create share link")
	}

	if err := recordDetails(ctx, tx, client, "share.created", &authUser.ID, &authUser.Username, &shareLink.ID, true, nil, &roomID,
		map[string]any{"canEdit": canEdit}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("share link created",
		"actor_id", authUser.ID,
		"actor_role", authUser.Role,
		"room_id", room.ID,
		"owner_id", room.OwnerID,
		"share_link_id", shareLink.ID,
		"can_edit", shareLink.CanEdit,
		"expires_at", shareLink.ExpiresAt,
	)

	writeJSON(w, http.StatusCreated, map[string]any{
		"shareLink": a.formatShareLink(&shareLink),
	})
	return nil
}

func (a *App) listShareLinks(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	ctx := r.Context()
	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	room, err := queryOptional[RoomOwnerOnlyRow](ctx, a.DB, `
        SELECT id, "ownerId" as owner_id
        FROM "Room"
        WHERE id = $1
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load room")
	}

	if room == nil {
		return notFound("Room not found")
	}

	if !canManageRoomShares(authUser, room.OwnerID) {
		return notFound("Room not found")
	}

	shareLinks, err := queryAll[ShareLinkSummaryRow](ctx, a.DB, `
        SELECT
            l.id,
            l.token,
            l."canEdit" as can_edit,
            l."createdAt" as created_at,
            l."expiresAt" as expires_at,
            l."consumedAt" as consumed_at,
            l."roomId" as room_id,
            COUNT(g.id) as guest_count
        FROM "RoomShareLink" l
        LEFT JOIN "GuestSession" g ON g."shareLinkId" = l.id
        WHERE l."roomId" = $1
          AND l."consumedAt" IS NULL
        GROUP BY l.id
        ORDER BY l."createdAt" DESC
        `, room.ID)
	if err != nil {
		return dbError(err, "Failed to load share links")
	}

	out := make([]map[string]any, 0, len(shareLinks))
	for i := range shareLinks {
		out = append(out, a.formatShareLink(&shareLinks[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"shareLinks": out})
	return nil
}

func (a *App) deleteShareLink(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	roomID, shareLinkID := r.PathValue("roomId"), r.PathValue("shareLinkId")
	ctx := r.Context()
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	if _, err := requireRoomAccess(ctx, a.DB, authUser, roomID); err != nil {
		return err
	}
	shareLink, err := queryOptional[ShareLinkOwnerRow](ctx, a.DB, `
        SELECT l."roomId" as room_id, r."ownerId" as owner_id
        FROM "RoomShareLink" l
        JOIN "Room" r ON r.id = l."roomId"
        WHERE l.id = $1
        `, shareLinkID)
	if err != nil {
		return dbError(err, "Failed to load share link")
	}

	if shareLink == nil || shareLink.RoomID != roomID {
		return notFound("Share link not found")
	}

	if !canManageRoomShares(authUser, shareLink.OwnerID) {
		return notFound("Share link not found")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start revocation")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `DELETE FROM "RoomShareLink" WHERE id = $1`, shareLinkID); err != nil {
		return dbError(err, "Failed to delete share link")
	}

	slog.Info("share link deleted",
		"actor_id", authUser.ID,
		"actor_role", authUser.Role,
		"room_id", roomID,
		"owner_id", shareLink.OwnerID,
		"share_link_id", shareLinkID,
	)

	if err := recordDetails(ctx, tx, client, "share.revoke", &authUser.ID, &authUser.Username, &shareLinkID, true, nil, &roomID,
		map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit revocation")
	}
	a.WS.RevokeShare(roomID, shareLinkID)

	writeJSON(w, http.StatusOK, map[string]any{"message": "Share link deleted"})
	return nil
}

const shareLinkWithRoomSelect = `
                SELECT
                    l.id,
                    l.token,
                    l."canEdit" as can_edit,
                    l."createdAt" as created_at,
                    l."expiresAt" as expires_at,
                    l."consumedAt" as consumed_at,
                    r.id as room_id,
                    r.name as room_name,
                    r.language as room_language,
                    r."allowEdit" as room_allow_edit,
                    r."isDeleted" as room_is_deleted,
                    r."isEnded" as room_is_ended,
                    r."endedAt" as room_ended_at
                FROM "RoomShareLink" l
                JOIN "Room" r ON r.id = l."roomId"
                `

func (a *App) joinShareLink(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	token := r.PathValue("token")
	var payload JoinSharePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	username := ""
	if payload.Username != nil {
		username = strings.TrimSpace(*payload.Username)
	}

	if username == "" {
		return badRequest("Username is required")
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start share join transaction")
	}
	defer tx.Rollback(context.Background())

	claimed, err := queryOptional[ClaimedShareLinkRow](ctx, tx, `
        UPDATE "RoomShareLink"
        SET "consumedAt" = NOW()
        WHERE token = $1
          AND "consumedAt" IS NULL
          AND "expiresAt" > NOW()
        RETURNING
            id
        `, token)
	if err != nil {
		return dbError(err, "Failed to claim share link")
	}

	if claimed == nil {
		existing, err := queryOptional[ShareLinkWithRoomRow](ctx, tx, shareLinkWithRoomSelect+`WHERE l.token = $1
                `, token)
		if err != nil {
			return dbError(err, "Failed to load share link")
		}

		return shareLinkAccessError(existing)
	}

	shareLink, err := queryOptional[ShareLinkWithRoomRow](ctx, tx, shareLinkWithRoomSelect+`WHERE l.id = $1
        `, claimed.ID)
	if err != nil {
		return dbError(err, "Failed to load room for share link")
	}

	if shareLink == nil || shareLink.RoomIsDeleted {
		return notFound("Share link not found")
	}

	if shareLink.RoomIsEnded {
		return badRequest("This room has already ended")
	}

	sessionToken := randomTokenHex(24)
	guestColor := randomUserColor()
	canEdit := shareLink.CanEdit && shareLink.RoomAllowEdit

	guestID, err := scalar[string](ctx, tx, `
        INSERT INTO "GuestSession" (id, "shareLinkId", "roomId", token, "displayName", color, "canEdit")
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        `, uuid.NewString(), shareLink.ID, shareLink.RoomID, sessionToken, username, guestColor, canEdit)
	if err != nil {
		return dbError(err, "Failed to create guest session")
	}

	claims := buildGuestClaims(guestID, shareLink.RoomID, shareLink.ID, username, guestColor, canEdit, sessionToken, time.Now())

	jwtToken, err := generateGuestToken(a.Config, claims)
	if err != nil {
		return err
	}

	if err := recordDetails(ctx, tx, client, "guest.join", &guestID, &username, &shareLink.RoomID, true, nil, &shareLink.RoomID,
		map[string]any{"canEdit": canEdit}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to finalize share link join")
	}

	slog.Info("share link joined",
		"share_link_id", shareLink.ID,
		"room_id", shareLink.RoomID,
		"guest_id", guestID,
		"guest_name", username,
		"can_edit", canEdit,
	)

	writeJSON(w, http.StatusCreated, map[string]any{
		"token":       jwtToken,
		"redirectUrl": a.buildRoomURL(shareLink.RoomID),
		"guest": map[string]any{
			"id":          guestID,
			"displayName": username,
			"color":       guestColor,
			"canEdit":     canEdit,
		},
		"room": map[string]any{
			"id":         shareLink.RoomID,
			"name":       shareLink.RoomName,
			"language":   shareLink.RoomLanguage,
			"documentId": shareLink.RoomID,
			"allowEdit":  shareLink.RoomAllowEdit,
			"isEnded":    shareLink.RoomIsEnded,
			"endedAt":    isoStringOpt(shareLink.RoomEndedAt),
		},
	})
	return nil
}

type AccountInvitation struct {
	ID             string `db:"id"`
	RoomID         string `db:"room_id"`
	CanEdit        bool   `db:"can_edit"`
	CanView        bool   `db:"can_view"`
	GrantsReplay   bool   `db:"grants_replay"`
	IsOwner        bool   `db:"is_owner"`
	AlreadyClaimed bool   `db:"already_claimed"`
	Consumed       bool   `db:"consumed"`
	Expired        bool   `db:"expired"`
}

// acceptShareLink claims an invitation atomically. A tech joining someone
// else's room gets the link's permission: the link last joined through
// decides, so a later read-only link downgrades an earlier edit link and vice
// versa. A standard room stays available for replay once it ends. The owner,
// and staff who can already see the room, keep their own access and leave the
// link unused. Reopening the same claimed invitation is idempotent.
func (a *App) acceptShareLink(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	token := r.PathValue("token")
	ctx := r.Context()
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to begin invitation")
	}
	defer tx.Rollback(context.Background())
	row, err := queryOptional[AccountInvitation](ctx, tx, `
        SELECT l.id, l."roomId" as room_id, l."canEdit" AND r."allowEdit" as can_edit,
            l."consumedAt" IS NOT NULL as consumed,
            NOT r."isPrivate" as grants_replay,
            r."ownerId" = $2 as is_owner,
            EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $2 AND p."shareLinkId" = l.id) as already_claimed,
            room_is_visible($2, $3, $4, r."ownerId", o.role, r."isPrivate", r."isPinned", r."isEnded", r."isDeleted",
                EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $2),
                EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $2 AND p."canReplay")) as can_view,
            l."expiresAt" <= NOW() as expired
        FROM "RoomShareLink" l JOIN "Room" r ON r.id=l."roomId"
        JOIN "User" o ON o.id = r."ownerId"
        WHERE l.token=$1 AND NOT r."isDeleted" AND NOT r."isEnded"
        FOR UPDATE OF l
    `, token, authUser.ID, authUser.Role, hasGlobalRead(authUser))
	if err != nil {
		return dbError(err, "Failed to load invitation")
	}
	if row == nil {
		return notFound("Share link or active room not found")
	}
	claimed := !row.AlreadyClaimed && !row.IsOwner && (!row.CanView || !hasGlobalRead(authUser))
	if claimed {
		if row.Consumed {
			return gone("This share link has already been used")
		}
		if row.Expired {
			return gone("This share link has expired")
		}
		// The link replaces any earlier grant, including another link's.
		// Revocation removes that grant, including its replay permission.
		if _, err := tx.Exec(ctx, `INSERT INTO "RoomParticipant" (id,"roomId","userId","canEdit","shareLinkId","canReplay")
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT ("roomId","userId") DO UPDATE
            SET "canEdit" = EXCLUDED."canEdit", "shareLinkId" = EXCLUDED."shareLinkId", "canReplay" = EXCLUDED."canReplay"`,
			uuid.NewString(), row.RoomID, authUser.ID, row.CanEdit, row.ID, row.GrantsReplay); err != nil {
			return dbError(err, "Failed to join room")
		}
		if _, err := tx.Exec(ctx, `UPDATE "RoomShareLink" SET "consumedAt"=NOW() WHERE id=$1`, row.ID); err != nil {
			return dbError(err, "Failed to claim invitation")
		}
	}
	if err := recordDetails(ctx, tx, client, "share.accept", &authUser.ID, &authUser.Username, &row.RoomID, true, nil, &row.RoomID,
		map[string]any{"canEdit": row.CanEdit, "canReplay": row.GrantsReplay, "claimed": claimed}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to accept invitation")
	}
	if claimed {
		a.WS.RevokeRoomActor(row.RoomID, authUser.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"roomId": row.RoomID})
	return nil
}

func (a *App) formatShareLink(link *ShareLinkSummaryRow) map[string]any {
	isConsumed := link.ConsumedAt != nil
	isExpired := !isConsumed && !link.ExpiresAt.After(time.Now())

	base := a.Config.AppURL
	if base == nil {
		base = a.Config.FrontendURL
	}
	var shareURL *string
	if base != nil {
		shareURL = ptr(strings.TrimRight(*base, "/") + "/s/" + link.Token)
	}

	return map[string]any{
		"id":         link.ID,
		"token":      link.Token,
		"shareUrl":   shareURL,
		"canEdit":    link.CanEdit,
		"createdAt":  isoString(link.CreatedAt),
		"expiresAt":  isoString(link.ExpiresAt),
		"consumedAt": isoStringOpt(link.ConsumedAt),
		"guestCount": link.GuestCount,
		"isConsumed": isConsumed,
		"isExpired":  isExpired,
	}
}

func (a *App) buildRoomURL(roomID string) *string {
	base := a.Config.FrontendURL
	if base == nil {
		base = a.Config.AppURL
	}
	if base == nil {
		return nil
	}
	normalized := strings.TrimRight(*base, "/")
	path := "room/" + roomID
	if a.Config.FrontendHashRouter {
		path = "#/room/" + roomID
	}
	return ptr(normalized + "/" + path)
}

// canManageRoomShares: the owner, agents and admins share rooms; members who
// joined by link cannot re-share.
func canManageRoomShares(authUser *AuthUser, ownerID string) bool {
	return canManageRoom(authUser, ownerID)
}

func shareLinkIsConsumed(link *ShareLinkWithRoomRow) bool {
	return link.ConsumedAt != nil
}

func shareLinkIsExpired(link *ShareLinkWithRoomRow) bool {
	return link.ConsumedAt == nil && !link.ExpiresAt.After(time.Now())
}

func shareLinkAccessError(link *ShareLinkWithRoomRow) *ApiError {
	if link == nil {
		return notFound("Share link not found")
	}

	if link.RoomIsDeleted {
		return notFound("Share link not found")
	}

	if shareLinkIsConsumed(link) {
		return gone("This share link has already been used")
	}

	if shareLinkIsExpired(link) {
		return gone("This share link has expired")
	}

	if link.RoomIsEnded {
		return badRequest("This room has already ended")
	}

	return notFound("Share link not found")
}

func randomTokenHex(bytes int) string {
	data := make([]byte, bytes)
	if _, err := rand.Read(data); err != nil {
		panic(err)
	}
	return hex.EncodeToString(data)
}

func randomSlug(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		panic(err)
	}
	out := make([]byte, length)
	for i, b := range bytes {
		out[i] = charset[int(b)%len(charset)]
	}
	return string(out)
}
