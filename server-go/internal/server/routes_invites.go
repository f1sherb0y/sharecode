package server

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/invites", h(a.createInvite))
		mux.HandleFunc("GET /api/invites", h(a.listInvites))
		mux.HandleFunc("DELETE /api/invites/{id}", h(a.deleteInvite))
	})
}

// Registration is invite-only: admins and agents issue single-use codes that
// expire after 7 days, and a tech registers with one. An unused invite also
// stops working once its issuer is removed or is no longer an agent or admin.

// codeAlphabet has no 0/O or 1/I. 32 symbols, so every random byte maps
// without bias.
const codeAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
const codeLength = 12
const maxNoteChars = 100

// i is the invite, c its issuer.
const inviteExpiredSQL = `(i."expiresAt" <= NOW() OR c."isDeleted" OR room_role_rank(c.role) = 0)`

type CreateInvitePayload struct {
	Note *string `json:"note"`
}

type InviteRow struct {
	ID                string     `db:"id"`
	Code              string     `db:"code"`
	Note              *string    `db:"note"`
	CreatedAt         time.Time  `db:"created_at"`
	ExpiresAt         time.Time  `db:"expires_at"`
	UsedAt            *time.Time `db:"used_at"`
	CreatedByID       string     `db:"created_by_id"`
	CreatedByUsername string     `db:"created_by_username"`
	UsedByID          *string    `db:"used_by_id"`
	UsedByUsername    *string    `db:"used_by_username"`
	IsExpired         bool       `db:"is_expired"`
}

func inviteSelect(source string) string {
	return `SELECT i.id, i.code, i.note, i."createdAt" as created_at, i."expiresAt" as expires_at,
        i."usedAt" as used_at, c.id as created_by_id, c.username as created_by_username,
        u.id as used_by_id, u.username as used_by_username, ` + inviteExpiredSQL + ` as is_expired
        FROM ` + source + ` i JOIN "User" c ON c.id = i."createdBy" LEFT JOIN "User" u ON u.id = i."usedBy"`
}

// authNoRows: the query found no row (fetch_optional's None).
func authNoRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }

func (a *App) createInvite(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	var payload CreateInvitePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	var note *string
	if payload.Note != nil {
		if trimmed := strings.TrimSpace(*payload.Note); trimmed != "" {
			note = &trimmed
		}
	}
	if note != nil && utf8.RuneCountInString(*note) > maxNoteChars {
		return badRequest("Invite note is too long")
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	invite, err := queryOne[InviteRow](ctx, tx, `WITH created AS (
            INSERT INTO "RegistrationInvite" (id, code, note, "createdBy", "expiresAt")
            VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days')
            RETURNING *
        ) `+inviteSelect("created"), uuid.NewString(), generateCode(), note, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to create invite")
	}
	// The code is a credential and the note may name a person: neither is audited.
	if err := recordDetails(ctx, tx, client, "invite.created", &authUser.ID, &authUser.Username, &invite.ID, true, nil, nil,
		map[string]any{"expiresAt": isoString(invite.ExpiresAt)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	writeJSON(w, http.StatusCreated, map[string]any{"invite": a.inviteJSON(&invite)})
	return nil
}

// listInvites: agents see the invites they issued; admins see everyone's.
func (a *App) listInvites(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	var issuer *string
	if !isAdmin(authUser.Role) {
		issuer = &authUser.ID
	}
	invites, err := queryAll[InviteRow](r.Context(), a.DB, inviteSelect(`"RegistrationInvite"`)+` WHERE $1::text IS NULL OR i."createdBy" = $1
        ORDER BY i."createdAt" DESC, i.id DESC LIMIT 100`, issuer)
	if err != nil {
		return dbError(err, "Failed to load invites")
	}

	out := make([]map[string]any, 0, len(invites))
	for i := range invites {
		out = append(out, a.inviteJSON(&invites[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": out})
	return nil
}

// deleteInvite: the issuer or an admin can withdraw an unused invite; used
// ones stay as the record.
func (a *App) deleteInvite(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	inviteID := r.PathValue("id")
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	deleted, err := scalarOptional[string](ctx, tx, `DELETE FROM "RegistrationInvite"
        WHERE id = $1 AND "usedAt" IS NULL AND ("createdBy" = $2 OR $3)
        RETURNING id`, inviteID, authUser.ID, isAdmin(authUser.Role))
	if err != nil {
		return dbError(err, "Failed to delete invite")
	}
	if deleted == nil {
		return notFound("Invite not found")
	}
	if err := recordDetails(ctx, tx, client, "invite.revoked", &authUser.ID, &authUser.Username, &inviteID, true, nil, nil,
		map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	writeJSON(w, http.StatusOK, map[string]any{"message": "Invite deleted"})
	return nil
}

// normalizeCode accepts a code as displayed (XXXX-XXXX-XXXX), in any case,
// with or without separators.
func normalizeCode(input string) string {
	var out strings.Builder
	for _, c := range input {
		switch {
		case c >= 'a' && c <= 'z':
			out.WriteRune(c - 'a' + 'A')
		case c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
			out.WriteRune(c)
		}
	}
	return out.String()
}

// InviteRejection is why a registration code was refused. Refusals are
// audited like failed sign-ins.
type InviteRejection int

const (
	InviteRejectionMissing InviteRejection = iota
	InviteRejectionInvalid
	InviteRejectionUsed
	InviteRejectionExpired
)

func (rejection InviteRejection) reason() string {
	switch rejection {
	case InviteRejectionMissing:
		return "missing_invite"
	case InviteRejectionInvalid:
		return "invalid_invite"
	case InviteRejectionUsed:
		return "invite_used"
	default:
		return "invite_expired"
	}
}

// apiError is From<InviteRejection> for ApiError.
func (rejection InviteRejection) apiError() *ApiError {
	switch rejection {
	case InviteRejectionMissing:
		return badRequest("Invite code is required")
	case InviteRejectionInvalid:
		return badRequest("Invalid invite code")
	case InviteRejectionUsed:
		return gone("This invite code has already been used")
	default:
		return gone("This invite code has expired")
	}
}

// findUsable checks a normalized registration code before any expensive
// work; it returns the invite ID, or the rejection when the code cannot be
// used.
func findUsable(ctx context.Context, db DBTX, code string) (string, *InviteRejection, error) {
	if code == "" {
		return "", ptr(InviteRejectionMissing), nil
	}
	var id string
	var used, expired bool
	err := db.QueryRow(ctx, `SELECT i.id, i."usedAt" IS NOT NULL, `+inviteExpiredSQL+`
        FROM "RegistrationInvite" i JOIN "User" c ON c.id = i."createdBy"
        WHERE i.code = $1`, code).Scan(&id, &used, &expired)
	switch {
	case authNoRows(err):
		return "", ptr(InviteRejectionInvalid), nil
	case err != nil:
		return "", nil, dbError(err, "Failed to check invite")
	case used:
		return "", ptr(InviteRejectionUsed), nil
	case expired:
		return "", ptr(InviteRejectionExpired), nil
	}
	return id, nil, nil
}

// claim consumes the invite for the account just inserted in this
// transaction and returns its issuer. Of two registrations racing for one
// code, the second finds it used and rolls back.
func claim(ctx context.Context, tx DBTX, inviteID, userID string) (string, error) {
	issuer, err := scalarOptional[string](ctx, tx, `UPDATE "RegistrationInvite" i SET "usedAt" = NOW(), "usedBy" = $2
        FROM "User" c
        WHERE i.id = $1 AND c.id = i."createdBy" AND i."usedAt" IS NULL AND NOT `+inviteExpiredSQL+`
        RETURNING i."createdBy"`, inviteID, userID)
	if err != nil {
		return "", dbError(err, "Failed to claim invite")
	}
	if issuer == nil {
		return "", gone("This invite code has already been used")
	}
	return *issuer, nil
}

func generateCode() string {
	var bytes [codeLength]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		panic(err)
	}
	out := make([]byte, codeLength)
	for i, b := range bytes {
		out[i] = codeAlphabet[b%32]
	}
	return string(out)
}

// inviteURL: web clients build the link from their own origin; desktop
// builds need this one.
func (a *App) inviteURL(code string) *string {
	base := a.Config.AppURL
	if base == nil {
		base = a.Config.FrontendURL
	}
	if base == nil {
		return nil
	}
	route := "register"
	if a.Config.FrontendHashRouter {
		route = "#/register"
	}
	return ptr(strings.TrimRight(*base, "/") + "/" + route + "?invite=" + code)
}

func (a *App) inviteJSON(invite *InviteRow) map[string]any {
	var usedBy any
	if invite.UsedByID != nil {
		usedBy = map[string]any{"id": *invite.UsedByID, "username": invite.UsedByUsername}
	}
	return map[string]any{
		"id":        invite.ID,
		"code":      invite.Code,
		"note":      invite.Note,
		"createdAt": isoString(invite.CreatedAt),
		"expiresAt": isoString(invite.ExpiresAt),
		"usedAt":    isoStringOpt(invite.UsedAt),
		"createdBy": map[string]any{"id": invite.CreatedByID, "username": invite.CreatedByUsername},
		"usedBy":    usedBy,
		"isUsed":    invite.UsedAt != nil,
		"isExpired": invite.UsedAt == nil && invite.IsExpired,
		"inviteUrl": a.inviteURL(invite.Code),
	}
}
