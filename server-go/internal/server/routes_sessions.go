package server

import (
	"context"
	"net/http"
	"time"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/auth/refresh", h(a.refresh))
		mux.HandleFunc("POST /api/auth/logout", h(a.logout))
	})
}

type SessionRow struct {
	ID           string `db:"id"`
	UserID       string `db:"user_id"`
	TokenVersion int64  `db:"token_version"`
}

// sessionHintDiffers: a hint header that is present must name expected.
func sessionHintDiffers(r *http.Request, header, expected string) bool {
	values := r.Header.Values(header)
	return len(values) > 0 && values[0] != expected
}

func (a *App) refresh(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	if err := checkCookieRequest(a.Config, r.Header); err != nil {
		return err
	}
	bearer, hasBearer := authBearerOnce(r)
	var identity *UserTokenPayload
	if hasBearer {
		payload, err := verifyRefreshIdentity(a.Config, bearer)
		if err != nil {
			return err
		}
		if payload.User == nil {
			return unauthorized("Invalid user session")
		}
		identity = payload.User
	}
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start session renewal")
	}
	defer tx.Rollback(context.Background())
	var user *UserRow
	var sessionID, secret string
	if cookie := cookieSecret(a.Config, r.Header); cookie != nil {
		row, err := queryOptional[SessionRow](ctx, tx, `SELECT id,"userId" AS user_id,"tokenVersion" AS token_version
            FROM "BrowserSession" WHERE "secretHash"=$1 AND "expiresAt">NOW() FOR UPDATE`, secretHash(*cookie))
		if err != nil {
			return dbError(err, "Failed to load browser session")
		}
		if row == nil {
			return unauthorized("Session expired")
		}
		if identity != nil && (identity.UserID != row.UserID || identity.TokenVersion != row.TokenVersion ||
			(identity.SessionID != nil && *identity.SessionID != row.ID)) {
			return unauthorized("Browser account changed; sign in again")
		}
		// Non-secret tab hints prevent a stale tab from adopting another login.
		for _, hint := range [][2]string{{"X-Session-User", row.UserID}, {"X-Session-Id", row.ID}} {
			if sessionHintDiffers(r, hint[0], hint[1]) {
				return unauthorized("Browser account changed; sign in again")
			}
		}
		user, err = loadSessionUser(ctx, tx, row.UserID)
		if err != nil {
			return err
		}
		if user.TokenVersion != row.TokenVersion {
			return unauthorized("Session expired")
		}
		if _, err := tx.Exec(ctx, `UPDATE "BrowserSession" SET "lastSeen"=NOW(),"expiresAt"=NOW()+INTERVAL '30 days' WHERE id=$1`, row.ID); err != nil {
			return dbError(err, "Failed to renew browser session")
		}
		sessionID, secret = row.ID, *cookie
	} else {
		// One-time upgrade for already signed-in clients from before cookies.
		// Session-bound or expired JWTs cannot replace a missing/revoked cookie.
		if !hasBearer {
			return unauthorized("No browser session")
		}
		verified, err := verifyToken(a.Config, bearer)
		if err != nil {
			return err
		}
		payload := verified.User
		if payload == nil || payload.SessionID != nil {
			return unauthorized("No browser session")
		}
		user, err = loadSessionUser(ctx, tx, payload.UserID)
		if err != nil {
			return err
		}
		if user.TokenVersion != payload.TokenVersion {
			return unauthorized("Session expired")
		}
		sessionID, secret, err = createSession(ctx, tx, user, client.DeviceID)
		if err != nil {
			return err
		}
	}
	claims := buildUserClaims(user, time.Now())
	claims.SessionID = &sessionID
	token, err := generateUserToken(a.Config, claims)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit session renewal")
	}
	writeSessionJSON(w, a.Config, http.StatusOK, secret, map[string]any{
		"token": token, "browserSessionId": sessionID, "user": map[string]any{
			"id": user.ID, "username": user.Username, "color": user.Color, "role": user.Role,
		},
	})
	return nil
}

func (a *App) logout(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	if err := checkCookieRequest(a.Config, r.Header); err != nil {
		return err
	}
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	if secret := cookieSecret(a.Config, r.Header); secret != nil {
		ctx := r.Context()
		tx, err := a.DB.Begin(ctx)
		if err != nil {
			return dbError(err, "Failed to start logout")
		}
		defer tx.Rollback(context.Background())
		row, err := queryOptional[SessionRow](ctx, tx, `SELECT id,"userId" AS user_id,"tokenVersion" AS token_version
            FROM "BrowserSession" WHERE "secretHash"=$1 FOR UPDATE`, secretHash(*secret))
		if err != nil {
			return dbError(err, "Failed to load logout session")
		}
		if row != nil {
			if sessionHintDiffers(r, "X-Session-Id", row.ID) {
				return unauthorized("Browser account changed; sign in again")
			}
			if _, err := tx.Exec(ctx, `DELETE FROM "BrowserSession" WHERE id=$1`, row.ID); err != nil {
				return dbError(err, "Failed to revoke browser session")
			}
			if err := record(ctx, tx, client, "session.logout", &row.UserID, nil, &row.ID, true, nil); err != nil {
				return err
			}
			if err := tx.Commit(ctx); err != nil {
				return dbError(err, "Failed to commit logout")
			}
			a.WS.RevokeSession(row.ID)
		}
	}
	writeSessionJSON(w, a.Config, http.StatusOK, "", map[string]any{"message": "Logged out"})
	return nil
}
