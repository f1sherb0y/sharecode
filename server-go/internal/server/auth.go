package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// UserTokenPayload is the claims of an account's token (type "user").
type UserTokenPayload struct {
	SessionID    *string `json:"sessionId,omitempty"`
	TokenVersion int64   `json:"tokenVersion"`
	UserID       string  `json:"userId"`
	Email        *string `json:"email"`
	Username     string  `json:"username"`
	Role         string  `json:"role"`
	Exp          int64   `json:"exp"`
	Iat          int64   `json:"iat"`
}

// GuestTokenPayload is the claims of a share guest's token (type "guest").
type GuestTokenPayload struct {
	GuestID      string `json:"guestId"`
	RoomID       string `json:"roomId"`
	ShareLinkID  string `json:"shareLinkId"`
	DisplayName  string `json:"displayName"`
	Color        string `json:"color"`
	CanEdit      bool   `json:"canEdit"`
	SessionToken string `json:"sessionToken"`
	Exp          int64  `json:"exp"`
	Iat          int64  `json:"iat"`
}

// TokenPayload is one of the two, as the token's "type" says.
type TokenPayload struct {
	User  *UserTokenPayload
	Guest *GuestTokenPayload
}

// AuthUser is the account a request was made by.
type AuthUser struct {
	SessionID    *string
	ID           string
	TokenVersion int64
	Username     string
	Email        *string
	Role         string
}

// AuthActor is who reads or writes room content: an account or a share
// guest. Guest claims still need the room-specific database check before
// use.
type AuthActor struct {
	User  *AuthUser
	Guest *GuestTokenPayload
}

func (a *AuthActor) ID() string {
	if a.User != nil {
		return a.User.ID
	}
	return a.Guest.GuestID
}

func (a *AuthActor) Username() string {
	if a.User != nil {
		return a.User.Username
	}
	return a.Guest.DisplayName
}

func signToken(config *Config, claims jwt.MapClaims) (string, error) {
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(config.JWTSecret))
	if err != nil {
		return "", internalError("Failed to sign token: " + err.Error())
	}
	return token, nil
}

func generateUserToken(config *Config, p UserTokenPayload) (string, error) {
	claims := jwt.MapClaims{
		"type": "user", "tokenVersion": p.TokenVersion, "userId": p.UserID, "email": p.Email,
		"username": p.Username, "role": p.Role, "exp": p.Exp, "iat": p.Iat,
	}
	if p.SessionID != nil {
		claims["sessionId"] = *p.SessionID
	}
	return signToken(config, claims)
}

func generateGuestToken(config *Config, p GuestTokenPayload) (string, error) {
	return signToken(config, jwt.MapClaims{
		"type": "guest", "guestId": p.GuestID, "roomId": p.RoomID, "shareLinkId": p.ShareLinkID,
		"displayName": p.DisplayName, "color": p.Color, "canEdit": p.CanEdit,
		"sessionToken": p.SessionToken, "exp": p.Exp, "iat": p.Iat,
	})
}

// buildUserClaims is a fifteen-minute token for user.
func buildUserClaims(user *UserRow, now time.Time) UserTokenPayload {
	return UserTokenPayload{
		TokenVersion: user.TokenVersion, UserID: user.ID, Email: user.Email, Username: user.Username,
		Role: user.Role, Exp: now.Add(15 * time.Minute).Unix(), Iat: now.Unix(),
	}
}

func buildGuestClaims(guestID, roomID, shareLinkID, displayName, color string, canEdit bool, sessionToken string, now time.Time) GuestTokenPayload {
	return GuestTokenPayload{
		GuestID: guestID, RoomID: roomID, ShareLinkID: shareLinkID, DisplayName: displayName, Color: color,
		CanEdit: canEdit, SessionToken: sessionToken,
		Exp: now.Add(guestShareTTLHours * time.Hour).Unix(), Iat: now.Unix(),
	}
}

// verifyToken checks signature and expiry (with the minute of leeway the
// Rust library allows).
func verifyToken(config *Config, token string) (*TokenPayload, error) {
	return decodeToken(config, token, true)
}

// verifyRefreshIdentity is used only to bind a refresh request to its
// cookie's actor and session. The cookie and the database still authorize
// the operation; an expired token alone never can.
func verifyRefreshIdentity(config *Config, token string) (*TokenPayload, error) {
	return decodeToken(config, token, false)
}

func decodeToken(config *Config, token string, validateExp bool) (*TokenPayload, error) {
	invalid := unauthorized("Invalid token")
	options := []jwt.ParserOption{jwt.WithValidMethods([]string{"HS256"}), jwt.WithLeeway(time.Minute)}
	if validateExp {
		options = append(options, jwt.WithExpirationRequired())
	} else {
		options = append(options, jwt.WithoutClaimsValidation())
	}
	claims := jwt.MapClaims{}
	if _, err := jwt.NewParser(options...).ParseWithClaims(token, claims, func(*jwt.Token) (any, error) {
		return []byte(config.JWTSecret), nil
	}); err != nil {
		return nil, invalid
	}
	str := func(key string) (string, bool) { s, ok := claims[key].(string); return s, ok }
	num := func(key string) (int64, bool) { f, ok := claims[key].(float64); return int64(f), ok }
	exp, okExp := num("exp")
	iat, okIat := num("iat")
	if !okExp || !okIat {
		return nil, invalid
	}
	switch claims["type"] {
	case "user":
		p := &UserTokenPayload{Exp: exp, Iat: iat}
		var ok1, ok2, ok3 bool
		p.UserID, ok1 = str("userId")
		p.Username, ok2 = str("username")
		p.Role, ok3 = str("role")
		if !ok1 || !ok2 || !ok3 {
			return nil, invalid
		}
		// serde refuses a present field of the wrong type; an absent or
		// null optional one is none.
		if raw, present := claims["tokenVersion"]; present {
			if _, isNumber := raw.(float64); !isNumber {
				return nil, invalid
			}
			p.TokenVersion, _ = num("tokenVersion")
		}
		for key, target := range map[string]**string{"sessionId": &p.SessionID, "email": &p.Email} {
			raw, present := claims[key]
			if !present || raw == nil {
				continue
			}
			text, isString := raw.(string)
			if !isString {
				return nil, invalid
			}
			*target = &text
		}
		return &TokenPayload{User: p}, nil
	case "guest":
		p := &GuestTokenPayload{Exp: exp, Iat: iat}
		ok := true
		get := func(key string) string {
			s, found := str(key)
			ok = ok && found
			return s
		}
		p.GuestID, p.RoomID, p.ShareLinkID = get("guestId"), get("roomId"), get("shareLinkId")
		p.DisplayName, p.Color, p.SessionToken = get("displayName"), get("color"), get("sessionToken")
		canEdit, found := claims["canEdit"].(bool)
		if !ok || !found {
			return nil, invalid
		}
		p.CanEdit = canEdit
		return &TokenPayload{Guest: p}, nil
	}
	return nil, invalid
}

func extractBearerToken(r *http.Request) (string, error) {
	value := r.Header.Get("Authorization")
	if !strings.HasPrefix(value, "Bearer ") {
		return "", unauthorized("No token provided")
	}
	// trim_start_matches removes every leading "Bearer ".
	for strings.HasPrefix(value, "Bearer ") {
		value = strings.TrimPrefix(value, "Bearer ")
	}
	return value, nil
}

const userRowColumns = `id, email, username, password, color, role, "isDeleted" as is_deleted,
    "createdAt" as created_at, "tokenVersion" as token_version, "lastSeen" as last_seen`

// userFromPayload loads the account a user token names and checks that the
// token is still good for it: not deleted, the same token version, and the
// browser session, if the token is bound to one, alive.
func (a *App) userFromPayload(ctx context.Context, p *UserTokenPayload) (*AuthUser, error) {
	user, err := queryOptional[UserRow](ctx, a.DB, `SELECT `+userRowColumns+`
        FROM "User"
        WHERE id = $1 AND ($2::text IS NULL OR EXISTS (
            SELECT 1 FROM "BrowserSession" s WHERE s.id=$2 AND s."userId"="User".id
            AND s."tokenVersion"="User"."tokenVersion" AND s."expiresAt">NOW()))`, p.UserID, p.SessionID)
	if err != nil {
		return nil, dbError(err, "Failed to load user")
	}
	if user == nil || user.IsDeleted || user.TokenVersion != p.TokenVersion {
		return nil, unauthorized("Invalid token")
	}
	return &AuthUser{SessionID: p.SessionID, TokenVersion: user.TokenVersion, ID: user.ID,
		Username: user.Username, Email: user.Email, Role: user.Role}, nil
}

// authUser is the AuthUser extractor: the account behind the bearer token,
// 401 otherwise.
func (a *App) authUser(r *http.Request) (*AuthUser, error) {
	token, err := extractBearerToken(r)
	if err != nil {
		return nil, err
	}
	payload, err := verifyToken(a.Config, token)
	if err != nil {
		return nil, err
	}
	if payload.User == nil {
		return nil, unauthorized("Invalid token")
	}
	return a.userFromPayload(r.Context(), payload.User)
}

// staffUser is the StaffUser extractor: an agent or admin; everyone else
// gets 404.
func (a *App) staffUser(r *http.Request) (*AuthUser, error) {
	user, err := a.authUser(r)
	if err != nil {
		return nil, err
	}
	if !isStaff(user.Role) {
		return nil, notFound("Not found")
	}
	return user, nil
}

// adminUser is the AdminUser extractor: an admin; everyone else, agents
// included, gets 404.
func (a *App) adminUser(r *http.Request) (*AuthUser, error) {
	user, err := a.authUser(r)
	if err != nil {
		return nil, err
	}
	if !isAdmin(user.Role) {
		return nil, notFound("Not found")
	}
	return user, nil
}

// authActor is the AuthActor extractor: an account or a share guest.
func (a *App) authActor(r *http.Request) (*AuthActor, error) {
	token, err := extractBearerToken(r)
	if err != nil {
		return nil, err
	}
	payload, err := verifyToken(a.Config, token)
	if err != nil {
		return nil, err
	}
	if payload.Guest != nil {
		return &AuthActor{Guest: payload.Guest}, nil
	}
	user, err := a.userFromPayload(r.Context(), payload.User)
	if err != nil {
		return nil, err
	}
	return &AuthActor{User: user}, nil
}
