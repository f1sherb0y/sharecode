package server

import (
	"context"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// The work tables' two lists: the techs whose tables are shown and the 管理 who
// book. Every name stands for an account; someone without one gets a placeholder
// ("linkOnly") nobody signs in as, later linked to their account by merging it.
// Staff keep both lists.

// rosterMaxNameChars is MAX_NAME_CHARS of roster.rs (customers.rs has a
// constant of the same name).
const rosterMaxNameChars = 32

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/roster", h(a.listRoster))
		mux.HandleFunc("POST /api/roster", h(a.addRosterEntry))
		mux.HandleFunc("PUT /api/roster/{kind}/{user_id}", h(a.updateRosterEntry))
		mux.HandleFunc("DELETE /api/roster/{kind}/{user_id}", h(a.removeRosterEntry))
	})
}

type EntryRow struct {
	Kind     string `db:"kind"`
	UserID   string `db:"user_id"`
	Name     string `db:"name"`
	Username string `db:"username"`
	Color    string `db:"color"`
	Role     string `db:"role"`
	LinkOnly bool   `db:"link_only"`
}

func entryJson(row *EntryRow) map[string]any {
	return map[string]any{
		"userId": row.UserID, "name": row.Name, "username": row.Username,
		"color": row.Color, "role": row.Role, "linkOnly": row.LinkOnly,
	}
}

func loadEntries(ctx context.Context, db DBTX) ([]EntryRow, error) {
	rows, err := queryAll[EntryRow](ctx, db, `SELECT e.kind, e."userId" as user_id, e.name, u.username, u.color, u.role, u."linkOnly" as link_only
        FROM "RosterEntry" e JOIN "User" u ON u.id = e."userId" AND NOT u."isDeleted"
        ORDER BY e.position, e."createdAt"`)
	if err != nil {
		return nil, dbError(err, "Failed to load the lists")
	}
	return rows, nil
}

// findEntry is the entry of a list standing for a user, as JSON; nil (null)
// when there is none.
func findEntry(ctx context.Context, db DBTX, kind, userID string) (map[string]any, error) {
	rows, err := loadEntries(ctx, db)
	if err != nil {
		return nil, err
	}
	for i := range rows {
		if rows[i].Kind == kind && rows[i].UserID == userID {
			return entryJson(&rows[i]), nil
		}
	}
	return nil, nil
}

func (a *App) listRoster(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.staffUser(r); err != nil {
		return err
	}
	rows, err := loadEntries(r.Context(), a.DB)
	if err != nil {
		return err
	}
	of := func(kind string) []map[string]any {
		out := []map[string]any{}
		for i := range rows {
			if rows[i].Kind == kind {
				out = append(out, entryJson(&rows[i]))
			}
		}
		return out
	}
	writeJSON(w, http.StatusOK, map[string]any{"techs": of("tech"), "managers": of("manager")})
	return nil
}

func checkKind(kind string) error {
	switch kind {
	case "tech", "manager":
		return nil
	}
	return notFound("Not found")
}

// rosterCleanName is clean_name of roster.rs (customers.rs has a function of
// the same name).
func rosterCleanName(name *string) (string, error) {
	var cleaned string
	if name != nil {
		cleaned = strings.TrimSpace(*name)
	}
	length := utf8.RuneCountInString(cleaned)
	if length == 0 || length > rosterMaxNameChars || strings.ContainsFunc(cleaned, unicode.IsControl) {
		return "", badRequest("A name of up to 32 characters is required")
	}
	return cleaned, nil
}

// checkAccount: an account a list entry may stand for: active, real, and
// staff for the 管理 list.
func checkAccount(ctx context.Context, tx DBTX, kind, account string) error {
	role, err := scalarOptional[string](ctx, tx,
		`SELECT role FROM "User" WHERE id = $1 AND NOT "isDeleted" AND NOT "linkOnly"`, account)
	if err != nil {
		return dbError(err, "Failed to load the account")
	}
	if role != nil && (kind == "tech" || isStaff(*role)) {
		return nil
	}
	return badRequest("Choose an account")
}

func listedError(err error) *ApiError {
	if _, ok := uniqueViolation(err); ok {
		return badRequest("Already on the list")
	}
	return dbError(err, "Failed to save the list")
}

type EntryPayload struct {
	Kind      *string `json:"kind"`
	Name      *string `json:"name"`
	AccountID *string `json:"accountId"`
}

// addRosterEntry adds a name to a list: an account, or a placeholder made
// for it.
func (a *App) addRosterEntry(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	var payload EntryPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	var kind string
	if payload.Kind != nil {
		kind = *payload.Kind
	}
	if checkKind(kind) != nil {
		return badRequest("Invalid list")
	}
	name, err := rosterCleanName(payload.Name)
	if err != nil {
		return err
	}
	account := payload.AccountID
	if account != nil && *account == "" {
		account = nil
	}
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	// One list change at a time keeps positions in order.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('roster', 0))"); err != nil {
		return dbError(err, "Failed to lock the lists")
	}
	var userID string
	if account != nil {
		if err := checkAccount(ctx, tx, kind, *account); err != nil {
			return err
		}
		userID = *account
	} else {
		if holder, err := usernameHolder(ctx, tx, name, nil); err != nil {
			return err
		} else if holder != nil {
			return badRequest("Username already taken")
		}
		id := uuid.NewString()
		password, err := bcrypt.GenerateFromPassword([]byte(randomToken(passwordChars)), 10)
		if err != nil {
			return internalError("Failed to hash password: " + err.Error())
		}
		var token *string
		role := "agent"
		if kind == "tech" {
			token = ptr(randomToken(linkChars))
			role = "tech"
		}
		if _, err := tx.Exec(ctx, `INSERT INTO "User" (id, username, password, color, role, "linkOnly", "tableToken")
                VALUES ($1, $2, $3, $4, $5, true, $6)`, id, name, string(password), randomUserColor(), role, token); err != nil {
			return userCreationError(err)
		}
		userID = id
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "RosterEntry" (kind, "userId", name, position)
        VALUES ($1, $2, $3, (SELECT COALESCE(max(position), 0) + 1 FROM "RosterEntry" WHERE kind = $1))`, kind, userID, name); err != nil {
		return listedError(err)
	}
	if err := recordDetails(ctx, tx, client, "roster.added", &authUser.ID, &authUser.Username,
		&userID, true, nil, nil, map[string]any{"kind": kind}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	entry, err := findEntry(ctx, a.DB, kind, userID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"entry": entry})
	return nil
}

// updateRosterEntry renames an entry, or links it to an account: a
// placeholder's sessions move there.
func (a *App) updateRosterEntry(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	kind, userID := r.PathValue("kind"), r.PathValue("user_id")
	var payload EntryPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := checkKind(kind); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('roster', 0))"); err != nil {
		return dbError(err, "Failed to lock the lists")
	}
	linkOnly, err := scalarOptional[bool](ctx, tx, `SELECT u."linkOnly" FROM "RosterEntry" e JOIN "User" u ON u.id = e."userId"
        WHERE e.kind = $1 AND e."userId" = $2 FOR UPDATE OF e`, kind, userID)
	if err != nil {
		return dbError(err, "Failed to load the list")
	}
	if linkOnly == nil {
		return notFound("Not found")
	}
	if payload.Name != nil {
		name, err := rosterCleanName(payload.Name)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE "RosterEntry" SET name = $3 WHERE kind = $1 AND "userId" = $2`, kind, userID, name); err != nil {
			return listedError(err)
		}
	}
	current := userID
	if payload.AccountID != nil && *payload.AccountID != "" && *payload.AccountID != userID {
		account := *payload.AccountID
		if err := checkAccount(ctx, tx, kind, account); err != nil {
			return err
		}
		taken, err := scalar[bool](ctx, tx, `SELECT EXISTS (SELECT 1 FROM "RosterEntry" WHERE kind = $1 AND "userId" = $2)`, kind, account)
		if err != nil {
			return dbError(err, "Failed to load the list")
		}
		if taken {
			return badRequest("Already on the list")
		}
		if *linkOnly {
			// Everything the placeholder held goes to the account, list entries included.
			if _, err := mergePlaceholder(ctx, tx, userID, account); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(ctx, `UPDATE "RosterEntry" SET "userId" = $3 WHERE kind = $1 AND "userId" = $2`, kind, userID, account); err != nil {
				return listedError(err)
			}
		}
		current = account
	}
	if err := recordDetails(ctx, tx, client, "roster.changed", &authUser.ID, &authUser.Username,
		&current, true, nil, nil, map[string]any{"kind": kind, "before": userID}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	entry, err := findEntry(ctx, a.DB, kind, current)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"entry": entry})
	return nil
}

// removeRosterEntry takes a name off a list; the account or placeholder and
// its sessions stay.
func (a *App) removeRosterEntry(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	kind, userID := r.PathValue("kind"), r.PathValue("user_id")
	if err := checkKind(kind); err != nil {
		return err
	}
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	tag, err := tx.Exec(ctx, `DELETE FROM "RosterEntry" WHERE kind = $1 AND "userId" = $2`, kind, userID)
	if err != nil {
		return dbError(err, "Failed to save the list")
	}
	if tag.RowsAffected() == 0 {
		return notFound("Not found")
	}
	if err := recordDetails(ctx, tx, client, "roster.removed", &authUser.ID, &authUser.Username,
		&userID, true, nil, nil, map[string]any{"kind": kind}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"removed": true})
	return nil
}
