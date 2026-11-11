package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/auth/register", h(a.register))
		mux.HandleFunc("POST /api/auth/login", h(a.login))
		mux.HandleFunc("GET /api/auth/profile", h(a.getProfile))
		mux.HandleFunc("POST /api/auth/change-password", h(a.changePassword))
		mux.HandleFunc("GET /api/auth/username", h(a.getUsernameChange))
		mux.HandleFunc("PUT /api/auth/username", h(a.changeUsername))
		mux.HandleFunc("GET /api/config/registration", h(a.getRegistrationStatus))
	})
}

type RegisterPayload struct {
	Username   *string `json:"username"`
	Password   *string `json:"password"`
	InviteCode *string `json:"inviteCode"`
}

type LoginPayload struct {
	Username *string `json:"username"`
	Password *string `json:"password"`
}

type ChangePasswordPayload struct {
	OldPassword *string `json:"oldPassword"`
	NewPassword *string `json:"newPassword"`
}

// authBcryptCost is the cost of every password hash these routes make.
const authBcryptCost = 12

// authBcryptInput is the password as the Rust bcrypt crate feeds it to the
// algorithm: only the first 72 bytes count. (x/crypto refuses to hash longer
// passwords; server-rs hashes and verifies them truncated.)
func authBcryptInput(password string) []byte {
	raw := []byte(password)
	if len(raw) > 72 {
		raw = raw[:72]
	}
	return raw
}

// authHashPassword is bcrypt's hash(password, 12).
func authHashPassword(password string) (string, error) {
	hashed, err := bcrypt.GenerateFromPassword(authBcryptInput(password), authBcryptCost)
	if err != nil {
		return "", internalError("Failed to hash password: " + err.Error())
	}
	return string(hashed), nil
}

// authVerifyPassword is bcrypt's verify: false for a wrong password, an
// error (500) for a stored hash that cannot be read.
func authVerifyPassword(password, hashed string) (bool, error) {
	err := bcrypt.CompareHashAndPassword([]byte(hashed), authBcryptInput(password))
	if err == nil {
		return true, nil
	}
	if errors.Is(err, bcrypt.ErrMismatchedHashAndPassword) {
		return false, nil
	}
	return false, internalError("Failed to verify password: " + err.Error())
}

// authBearerOnce is the Authorization header's token as the profile and
// refresh routes read it: the "Bearer " prefix is removed once; without the
// prefix there is no token.
func authBearerOnce(r *http.Request) (string, bool) {
	values := r.Header.Values("Authorization")
	if len(values) == 0 {
		return "", false
	}
	return strings.CutPrefix(values[0], "Bearer ")
}

// writeSessionJSON answers with the session cookie (an empty secret clears
// it) and forbids caching, as every response that carries a token does.
func writeSessionJSON(w http.ResponseWriter, config *Config, status int, secret string, body any) {
	w.Header().Set("Set-Cookie", cookieHeader(config, secret))
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, body)
}

func authOptString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// register: registration needs an invite code from an agent or admin and
// always creates a tech.
func (a *App) register(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	var payload RegisterPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := checkOrigin(a.Config, r.Header); err != nil {
		return err
	}
	ctx := r.Context()
	rawUsername := authOptString(payload.Username)
	password := authOptString(payload.Password)
	inviteCode := normalizeCode(authOptString(payload.InviteCode))

	if strings.TrimSpace(rawUsername) == "" || password == "" {
		return badRequest("Username and password are required")
	}
	username, ok := normalizeUsername(rawUsername)
	if !ok {
		return badRequest(invalidUsername)
	}

	if message := validatePassword(password); message != "" {
		return badRequest(message)
	}
	inviteID, rejection, err := findUsable(ctx, a.DB, inviteCode)
	if err != nil {
		return err
	}
	if rejection != nil {
		if err := record(ctx, a.DB, client, "user.registered", nil, &username, nil, false, ptr(rejection.reason())); err != nil {
			return err
		}
		return rejection.apiError()
	}

	holder, err := usernameHolder(ctx, a.DB, username, nil)
	if err != nil {
		return err
	}
	if holder != nil {
		return badRequest("Username already taken")
	}

	hashedPassword, err := authHashPassword(password)
	if err != nil {
		return err
	}
	color := randomUserColor()

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	user, err := queryOne[UserRow](ctx, tx, `
        INSERT INTO "User" (id, username, password, color, role)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            email,
            username,
            password,
            color,
            role,
            "isDeleted" as is_deleted,
            "createdAt" as created_at,
            "tokenVersion" as token_version, "lastSeen" as last_seen
        `, uuid.NewString(), username, hashedPassword, color, roleTech)
	if err != nil {
		return userCreationError(err)
	}
	invitedBy, err := claim(ctx, tx, inviteID, user.ID)
	if err != nil {
		return err
	}

	if err := identifyLoginDevice(ctx, tx, client, user.ID); err != nil {
		return err
	}
	if err := recordDetails(ctx, tx, client, "user.registered", &user.ID, &user.Username, &user.ID, true, nil, nil,
		map[string]any{"inviteId": inviteID, "invitedBy": invitedBy}); err != nil {
		return err
	}
	sessionID, secret, err := createSession(ctx, tx, &user, client.DeviceID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	claims := buildUserClaims(&user, time.Now())
	claims.SessionID = &sessionID
	token, err := generateUserToken(a.Config, claims)
	if err != nil {
		return err
	}

	writeSessionJSON(w, a.Config, http.StatusCreated, secret, map[string]any{
		"user": map[string]any{
			"id":       user.ID,
			"username": user.Username,
			"color":    user.Color,
			"role":     user.Role,
		},
		"token":            token,
		"browserSessionId": sessionID,
	})
	return nil
}

func (a *App) login(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	var payload LoginPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := checkOrigin(a.Config, r.Header); err != nil {
		return err
	}
	ctx := r.Context()
	username := authOptString(payload.Username)
	password := authOptString(payload.Password)

	if username == "" || password == "" {
		if err := record(ctx, a.DB, client, "login", nil, &username, nil, false, ptr("missing_credentials")); err != nil {
			return err
		}
		return badRequest("Username and password are required")
	}

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
        WHERE username = $1 AND NOT "linkOnly"
        `, username)
	if err != nil {
		return dbError(err, "Failed to load user")
	}

	if user == nil {
		if err := record(ctx, a.DB, client, "login", nil, &username, nil, false, ptr("invalid_credentials")); err != nil {
			return err
		}
		return unauthorized("Invalid credentials")
	}

	if user.IsDeleted {
		if err := record(ctx, a.DB, client, "login", &user.ID, &username, nil, false, ptr("account_disabled")); err != nil {
			return err
		}
		return unauthorized("Invalid credentials")
	}

	validPassword, err := authVerifyPassword(password, user.Password)
	if err != nil {
		return err
	}

	if !validPassword {
		if err := record(ctx, a.DB, client, "login", &user.ID, &username, nil, false, ptr("invalid_credentials")); err != nil {
			return err
		}
		return unauthorized("Invalid credentials")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	if err := identifyLoginDevice(ctx, tx, client, user.ID); err != nil {
		return err
	}
	if err := record(ctx, tx, client, "login", &user.ID, &username, nil, true, nil); err != nil {
		return err
	}

	sessionID, secret, err := createSession(ctx, tx, user, client.DeviceID)
	if err != nil {
		return err
	}
	claims := buildUserClaims(user, time.Now())
	claims.SessionID = &sessionID
	token, err := generateUserToken(a.Config, claims)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeSessionJSON(w, a.Config, http.StatusOK, secret, map[string]any{
		"user": map[string]any{
			"id":       user.ID,
			"username": user.Username,
			"color":    user.Color,
			"role":     user.Role,
		},
		"token":            token,
		"browserSessionId": sessionID,
	})
	return nil
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	var payload ChangePasswordPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := checkOrigin(a.Config, r.Header); err != nil {
		return err
	}
	ctx := r.Context()
	oldPassword := authOptString(payload.OldPassword)
	newPassword := authOptString(payload.NewPassword)

	if oldPassword == "" || newPassword == "" {
		return badRequest("Current password and new password are required")
	}

	if oldPassword == newPassword {
		return badRequest("New password must be different from current password")
	}

	if message := validatePassword(newPassword); message != "" {
		return badRequest(message)
	}

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
        `, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load user")
	}

	if user == nil || user.IsDeleted {
		return unauthorized("Invalid token")
	}

	validPassword, err := authVerifyPassword(oldPassword, user.Password)
	if err != nil {
		return err
	}

	if !validPassword {
		if err := record(ctx, a.DB, client, "password.changed", &user.ID, &user.Username, &user.ID, false, ptr("invalid_credentials")); err != nil {
			return err
		}
		return badRequest("Current password is incorrect")
	}

	hashedPassword, err := authHashPassword(newPassword)
	if err != nil {
		return err
	}

	// Compare-and-swap prevents two simultaneous password changes from
	// overwriting one another. Invalidate JWTs in the same transaction.
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start password update")
	}
	defer tx.Rollback(context.Background())
	version, err := scalarOptional[int64](ctx, tx, `UPDATE "User" SET password=$1, "tokenVersion"="tokenVersion"+1
        WHERE id=$2 AND password=$3 AND "tokenVersion"=$4 AND NOT "isDeleted" RETURNING "tokenVersion"`,
		hashedPassword, authUser.ID, user.Password, authUser.TokenVersion)
	if err != nil {
		return dbError(err, "Failed to update password")
	}
	if version == nil {
		return unauthorized("Session changed; sign in again")
	}
	if err := record(ctx, tx, client, "password.changed", &user.ID, &user.Username, &user.ID, true, nil); err != nil {
		return err
	}
	user.TokenVersion = *version
	sessionID, secret, err := createSession(ctx, tx, user, client.DeviceID)
	if err != nil {
		return err
	}
	claims := buildUserClaims(user, time.Now())
	claims.SessionID = &sessionID
	token, err := generateUserToken(a.Config, claims)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit password update")
	}
	a.WS.RevokeActor(authUser.ID)
	writeSessionJSON(w, a.Config, http.StatusOK, secret, map[string]any{
		"message": "Password updated", "token": token, "browserSessionId": sessionID,
	})
	return nil
}

// profileUserRow is the account row the profile query selects (UserPublicRow
// and the token version its SQL also returns).
type profileUserRow struct {
	ID           string    `db:"id"`
	Email        *string   `db:"email"`
	Username     string    `db:"username"`
	Color        string    `db:"color"`
	Role         string    `db:"role"`
	CreatedAt    time.Time `db:"created_at"`
	TokenVersion int64     `db:"token_version"`
	LastSeen     time.Time `db:"last_seen"`
}

type GuestProfileRow struct {
	ID            string     `db:"id"`
	ShareLinkID   string     `db:"share_link_id"`
	RoomID        string     `db:"room_id"`
	Token         string     `db:"token"`
	DisplayName   string     `db:"display_name"`
	Color         string     `db:"color"`
	CanEdit       bool       `db:"can_edit"`
	RoomName      string     `db:"room_name"`
	RoomLanguage  string     `db:"room_language"`
	RoomAllowEdit bool       `db:"room_allow_edit"`
	RoomIsDeleted bool       `db:"room_is_deleted"`
	RoomIsEnded   bool       `db:"room_is_ended"`
	RoomEndedAt   *time.Time `db:"room_ended_at"`
	ShareToken    string     `db:"share_token"`
	ShareCanEdit  bool       `db:"share_can_edit"`
}

func (a *App) getProfile(w http.ResponseWriter, r *http.Request) error {
	token, ok := authBearerOnce(r)
	if !ok {
		return unauthorized("No token provided")
	}

	payload, err := verifyToken(a.Config, token)
	if err != nil {
		return err
	}
	ctx := r.Context()

	if userPayload := payload.User; userPayload != nil {
		user, err := queryOptional[profileUserRow](ctx, a.DB, `
                SELECT
                    id,
                    email,
                    username,
                    color,
                    role,
                    "createdAt" as created_at,
                    "tokenVersion" as token_version, "lastSeen" as last_seen
                FROM "User"
                WHERE id = $1 AND "tokenVersion" = $2 AND NOT "isDeleted"
                  AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM "BrowserSession" s
                    WHERE s.id=$3 AND s."userId"="User".id AND s."tokenVersion"=$2 AND s."expiresAt">NOW()))
                `, userPayload.UserID, userPayload.TokenVersion, userPayload.SessionID)
		if err != nil {
			return dbError(err, "Failed to load profile")
		}

		if user == nil {
			return unauthorized("Session expired")
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"actorType": "user",
			"user": map[string]any{
				"id":        user.ID,
				"username":  user.Username,
				"color":     user.Color,
				"role":      user.Role,
				"createdAt": isoString(user.CreatedAt),
			},
		})
		return nil
	}

	guestPayload := payload.Guest
	guest, err := queryOptional[GuestProfileRow](ctx, a.DB, `
                SELECT
                    g.id,
                    g."shareLinkId" as share_link_id,
                    g."roomId" as room_id,
                    g.token,
                    g."displayName" as display_name,
                    g.color,
                    g."canEdit" as can_edit,
                    r.name as room_name,
                    r.language as room_language,
                    r."allowEdit" as room_allow_edit,
                    r."isDeleted" as room_is_deleted,
                    r."isEnded" as room_is_ended,
                    r."endedAt" as room_ended_at,
                    l.token as share_token,
                    l."canEdit" as share_can_edit
                FROM "GuestSession" g
                JOIN "Room" r ON r.id = g."roomId"
                JOIN "RoomShareLink" l ON l.id = g."shareLinkId"
                WHERE g.id = $1
                `, guestPayload.GuestID)
	if err != nil {
		return dbError(err, "Failed to load guest profile")
	}

	if guest == nil {
		return notFound("Session not found")
	}

	if guest.Token != guestPayload.SessionToken {
		return unauthorized("Session token mismatch")
	}

	if guest.RoomIsDeleted {
		return gone("Room no longer available")
	}

	effectiveCanEdit := guest.CanEdit && guest.RoomAllowEdit && guest.ShareCanEdit && !guest.RoomIsEnded

	if _, err := a.DB.Exec(ctx, `
                UPDATE "GuestSession"
                SET "lastActive" = $2, "canEdit" = $3
                WHERE id = $1
                `, guest.ID, time.Now().UTC(), effectiveCanEdit); err != nil {
		return dbError(err, "Failed to update guest session")
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"actorType": "guest",
		"guest": map[string]any{
			"id":          guest.ID,
			"displayName": guest.DisplayName,
			"color":       guest.Color,
			"canEdit":     effectiveCanEdit,
		},
		"room": map[string]any{
			"id":         guest.RoomID,
			"name":       guest.RoomName,
			"language":   guest.RoomLanguage,
			"documentId": guest.RoomID,
			"allowEdit":  guest.RoomAllowEdit,
			"isEnded":    guest.RoomIsEnded,
			"endedAt":    isoStringOpt(guest.RoomEndedAt),
		},
		"share": map[string]any{
			"id":      guest.ShareLinkID,
			"token":   guest.ShareToken,
			"canEdit": guest.ShareCanEdit,
		},
	})
	return nil
}

// getRegistrationStatus: open registration was replaced by invite codes.
// Clients from before then read false and hide their code-less form.
func (a *App) getRegistrationStatus(w http.ResponseWriter, _ *http.Request) error {
	writeJSON(w, http.StatusOK, map[string]any{"allowRegistration": false})
	return nil
}

// renameEveryDays: a username may change once a week.
const renameEveryDays = 7

type ChangeUsernamePayload struct {
	Username *string `json:"username"`
}

// getUsernameChange: when the signed-in account may next rename itself
// (null: now).
func (a *App) getUsernameChange(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	changedAt, err := scalar[*time.Time](r.Context(), a.DB, `SELECT "usernameChangedAt" FROM "User" WHERE id = $1`, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load account")
	}
	writeJSON(w, http.StatusOK, map[string]any{"nextChangeAt": isoStringOpt(nextRename(changedAt))})
	return nil
}

func nextRename(changedAt *time.Time) *time.Time {
	if changedAt == nil {
		return nil
	}
	next := changedAt.Add(renameEveryDays * 24 * time.Hour)
	if !next.After(time.Now()) {
		return nil
	}
	return &next
}

// changeUsername: anyone signed in renames themselves, once a week, to a
// name nobody else holds whatever its case. Everything refers to accounts by
// ID, so nothing else changes.
func (a *App) changeUsername(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	var payload ChangeUsernamePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := checkOrigin(a.Config, r.Header); err != nil {
		return err
	}
	ctx := r.Context()
	username, ok := normalizeUsername(authOptString(payload.Username))
	if !ok {
		return badRequest(invalidUsername)
	}
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	var current string
	var changedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT username, "usernameChangedAt" FROM "User" WHERE id = $1 AND NOT "isDeleted" FOR UPDATE`,
		authUser.ID).Scan(&current, &changedAt)
	if authNoRows(err) {
		return unauthorized("Invalid token")
	}
	if err != nil {
		return dbError(err, "Failed to load account")
	}
	if current == username {
		return badRequest("That is already your username")
	}
	if next := nextRename(changedAt); next != nil {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error": "Username changed recently", "nextChangeAt": isoString(*next),
		})
		return nil
	}
	// A change of case alone is the same name and stays free.
	holder, err := usernameHolder(ctx, tx, username, &authUser.ID)
	if err != nil {
		return err
	}
	if holder != nil {
		return badRequest("Username already taken")
	}
	if _, err := tx.Exec(ctx, `UPDATE "User" SET username = $2, "usernameChangedAt" = NOW() WHERE id = $1`,
		authUser.ID, username); err != nil {
		return userCreationError(err)
	}
	if err := recordDetails(ctx, tx, client, "user.renamed", &authUser.ID, &username, &authUser.ID, true, nil, nil,
		map[string]any{"before": current, "after": username}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	next := time.Now().Add(renameEveryDays * 24 * time.Hour)
	writeJSON(w, http.StatusOK, map[string]any{"username": username, "nextChangeAt": isoString(next)})
	return nil
}
