package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

// Work tables (工作表): one per tech, holding their sessions and busy time.
// Staff see every tech's table (and anyone else holding sessions still to
// come); a tech sees only their own. A tech pins a short note above it, such
// as when they cannot take sessions.
//
// Staff can give any table a link: whoever opens it sees that table without
// signing in, writes its note and marks busy time, nothing else. A table for
// someone without an account belongs to a placeholder tech ("linkOnly") that
// nobody can sign in as, merged into their real account once they have one.

// workTableMaxNoteChars is MAX_NOTE_CHARS of work_tables.rs (invites.rs has
// a constant of the same name).
const workTableMaxNoteChars = 200

// linkChars (LINK_CHARS): links are short to share yet too many to guess:
// 62^10 is about 2^59.
const linkChars = 10

// passwordChars is PASSWORD_CHARS.
const passwordChars = 32

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/work-tables", h(a.listWorkTables))
		mux.HandleFunc("PUT /api/work-tables/note", h(a.updateWorkTableNote))
		mux.HandleFunc("POST /api/work-tables", h(a.createWorkTable))
		mux.HandleFunc("POST /api/work-tables/{id}/link", h(a.resetWorkTableLink))
		mux.HandleFunc("POST /api/work-tables/{id}/merge", h(a.mergeWorkTable))
		mux.HandleFunc("GET /api/table-links/{token}", h(a.openTableLink))
		mux.HandleFunc("PUT /api/table-links/{token}/note", h(a.updateTableLinkNote))
		mux.HandleFunc("POST /api/table-links/{token}/busy", h(a.createTableLinkBusy))
		mux.HandleFunc("PUT /api/table-links/{token}/busy/{id}", h(a.updateTableLinkBusy))
		mux.HandleFunc("DELETE /api/table-links/{token}/busy/{id}", h(a.deleteTableLinkBusy))
	})
}

type TableRow struct {
	ID       string `db:"id"`
	Username string `db:"username"`
	// The name on the techs' list, else the username.
	Name     string  `db:"name"`
	Listed   bool    `db:"listed"`
	Color    string  `db:"color"`
	Role     string  `db:"role"`
	Note     *string `db:"note"`
	LinkOnly bool    `db:"link_only"`
	Token    *string `db:"token"`
	Upcoming int64   `db:"upcoming"`
}

func (a *App) listWorkTables(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	staff := isStaff(authUser.Role)
	rows, err := queryAll[TableRow](ctx, a.DB, `SELECT u.id, u.username, COALESCE(re.name, u.username) as name, re."userId" IS NOT NULL as listed,
            u.color, u.role, u."scheduleNote" as note,
            u."linkOnly" as link_only, u."tableToken" as token,
            (SELECT count(*) FROM "Appointment" a
             WHERE a."techId" = u.id AND NOT a."isBlock"
               AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW()) as upcoming
        FROM "User" u
        LEFT JOIN "RosterEntry" re ON re.kind = 'tech' AND re."userId" = u.id
        CROSS JOIN (SELECT EXISTS (SELECT 1 FROM "RosterEntry" WHERE kind = 'tech') as on_list) roster
        WHERE NOT u."isDeleted"
          AND ($1 OR u.id = $2)
          -- With a techs' list, staff see the tables on it; without, every tech's and
          -- anyone else's holding sessions still to come.
          AND CASE WHEN $1 AND roster.on_list THEN re."userId" IS NOT NULL
              ELSE u.role = 'tech' OR u.id = $2 OR EXISTS (
                SELECT 1 FROM "Appointment" a WHERE a."techId" = u.id AND NOT a."isBlock"
                  AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW()) END
        ORDER BY re.position NULLS LAST, lower(u.username), u.id`, staff, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load work tables")
	}
	// Sessions still waiting for a tech, which staff may still have to place.
	var unassigned int64
	if staff {
		unassigned, err = scalar[int64](ctx, a.DB, `SELECT count(*) FROM "Appointment"
            WHERE "techId" IS NULL AND "startsAt" + "durationMinutes" * INTERVAL '1 minute' > NOW()`)
		if err != nil {
			return dbError(err, "Failed to load work tables")
		}
	}
	tables := []map[string]any{}
	for _, row := range rows {
		if !(row.Listed || row.Role == "tech" || row.Upcoming > 0 || (!staff && row.ID == authUser.ID)) {
			continue
		}
		// The link opens the table without signing in: staff hand it out.
		var link *string
		if staff {
			link = row.Token
		}
		tables = append(tables, map[string]any{
			"id": row.ID, "username": row.Username, "name": row.Name, "color": row.Color, "role": row.Role,
			"note": row.Note, "upcoming": row.Upcoming, "linkOnly": row.LinkOnly,
			"link": link,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": tables, "unassigned": unassigned})
	return nil
}

type NotePayload struct {
	Note *string `json:"note"`
}

// updateWorkTableNote: the note pinned above the caller's own table; an
// empty one removes it.
func (a *App) updateWorkTableNote(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	var payload NotePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	return a.saveNote(w, r, authUser.ID, payload.Note)
}

func (a *App) saveNote(w http.ResponseWriter, r *http.Request, userID string, note *string) error {
	note, err := cleanText(note, workTableMaxNoteChars, "The note is too long")
	if err != nil {
		return err
	}
	if _, err := a.DB.Exec(r.Context(), `UPDATE "User" SET "scheduleNote" = $2 WHERE id = $1`, userID, note); err != nil {
		return dbError(err, "Failed to save the note")
	}
	writeJSON(w, http.StatusOK, map[string]any{"note": note})
	return nil
}

type NewTablePayload struct {
	Name *string `json:"name"`
}

// createWorkTable: a table for a tech without an account: a placeholder
// tech and its link.
func (a *App) createWorkTable(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	var payload NewTablePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()
	// A table's name is its placeholder's username.
	var rawName string
	if payload.Name != nil {
		rawName = *payload.Name
	}
	name, ok := normalizeUsername(rawName)
	if !ok {
		return badRequest(invalidUsername)
	}
	if holder, err := usernameHolder(ctx, a.DB, name, nil); err != nil {
		return err
	} else if holder != nil {
		return badRequest("Username already taken")
	}
	// A password nobody knows: the placeholder is reached through its link only.
	password, err := bcrypt.GenerateFromPassword([]byte(randomToken(passwordChars)), 10)
	if err != nil {
		return internalError("Failed to hash password: " + err.Error())
	}
	id := uuid.NewString()
	token := randomToken(linkChars)
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, `INSERT INTO "User" (id, username, password, color, role, "linkOnly", "tableToken")
        VALUES ($1, $2, $3, $4, 'tech', true, $5)`, id, name, string(password), randomUserColor(), token); err != nil {
		return userCreationError(err)
	}
	// With a techs' list, only listed tables show: the new one joins its end.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('roster', 0))"); err != nil {
		return dbError(err, "Failed to lock the lists")
	}
	listed, err := scalar[*bool](ctx, tx, `SELECT bool_or(lower(name) = lower($1)) FROM "RosterEntry" WHERE kind = 'tech'`, name)
	if err != nil {
		return dbError(err, "Failed to read the lists")
	}
	if listed != nil {
		if *listed {
			return badRequest("Already on the list")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO "RosterEntry" (kind, "userId", name, position)
                VALUES ('tech', $1, $2, (SELECT max(position) + 1 FROM "RosterEntry" WHERE kind = 'tech'))`, id, name); err != nil {
			return dbError(err, "Failed to add to the list")
		}
	}
	if err := recordDetails(ctx, tx, client, "work_table.created", &authUser.ID, &authUser.Username,
		&id, true, nil, nil, map[string]any{"linkOnly": true}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusCreated, map[string]any{"table": map[string]any{"id": id, "username": name, "link": token}})
	return nil
}

// resetWorkTableLink gives a table a new link; the old one stops working.
func (a *App) resetWorkTableLink(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	userID := r.PathValue("id")
	ctx := r.Context()
	token := randomToken(linkChars)
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	tag, err := tx.Exec(ctx, `UPDATE "User" SET "tableToken" = $2 WHERE id = $1 AND NOT "isDeleted"`, userID, token)
	if err != nil {
		return dbError(err, "Failed to save the link")
	}
	if tag.RowsAffected() == 0 {
		return notFound("Work table not found")
	}
	if err := recordDetails(ctx, tx, client, "work_table.link_reset", &authUser.ID, &authUser.Username,
		&userID, true, nil, nil, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"link": token})
	return nil
}

type MergePayload struct {
	Into *string `json:"into"`
}

// mergeWorkTable moves a placeholder's table into a real account: its
// sessions, busy time, rooms, note and link. The placeholder is removed.
func (a *App) mergeWorkTable(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	source := r.PathValue("id")
	var payload MergePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if payload.Into == nil || *payload.Into == "" {
		return badRequest("Choose an account")
	}
	target := *payload.Into
	if target == source {
		return badRequest("Choose another account")
	}
	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	moved, err := mergePlaceholder(ctx, tx, source, target)
	if err != nil {
		return err
	}
	if err := recordDetails(ctx, tx, client, "work_table.merged", &authUser.ID, &authUser.Username,
		&source, true, nil, nil, map[string]any{"into": target, "sessions": moved}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"merged": moved})
	return nil
}

// mergePlaceholder moves a placeholder's sessions (as tech and as 管理),
// rooms, note, link and list entries into a real account and removes the
// placeholder. Returns the sessions moved.
func mergePlaceholder(ctx context.Context, tx DBTX, source, target string) (int64, error) {
	var note, token *string
	err := tx.QueryRow(ctx,
		`SELECT "scheduleNote", "tableToken" FROM "User" WHERE id = $1 AND "linkOnly" AND NOT "isDeleted" FOR UPDATE`,
		source).Scan(&note, &token)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, notFound("Work table not found")
	}
	if err != nil {
		return 0, dbError(err, "Failed to load the work table")
	}
	account, err := scalarOptional[string](ctx, tx,
		`SELECT id FROM "User" WHERE id = $1 AND NOT "linkOnly" AND NOT "isDeleted" FOR UPDATE`, target)
	if err != nil {
		return 0, dbError(err, "Failed to load the account")
	}
	if account == nil {
		return 0, badRequest("Choose an account")
	}
	for _, key := range []string{source, target} {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "schedule:"+key); err != nil {
			return 0, dbError(err, "Failed to lock the schedule")
		}
	}
	movedTag, err := tx.Exec(ctx, `UPDATE "Appointment" SET "techId" = $2, "updatedAt" = NOW() WHERE "techId" = $1`, source, target)
	if err != nil {
		return 0, dbError(err, "Failed to move sessions")
	}
	managedTag, err := tx.Exec(ctx, `UPDATE "Appointment" SET "managerId" = $2, "updatedAt" = NOW() WHERE "managerId" = $1`, source, target)
	if err != nil {
		return 0, dbError(err, "Failed to move sessions")
	}
	// A list entry follows to the account unless the account is on that list already.
	if _, err := tx.Exec(ctx, `UPDATE "RosterEntry" e SET "userId" = $2 WHERE e."userId" = $1
          AND NOT EXISTS (SELECT 1 FROM "RosterEntry" o WHERE o.kind = e.kind AND o."userId" = $2)`, source, target); err != nil {
		return 0, dbError(err, "Failed to move list entries")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM "RosterEntry" WHERE "userId" = $1`, source); err != nil {
		return 0, dbError(err, "Failed to move list entries")
	}
	if _, err := tx.Exec(ctx, `UPDATE "Room" SET "ownerId" = $2, "updatedAt" = NOW() WHERE "ownerId" = $1`, source, target); err != nil {
		return 0, dbError(err, "Failed to move rooms")
	}
	// The placeholder goes; its link and note carry over unless the account has its own.
	if _, err := tx.Exec(ctx,
		`UPDATE "User" SET "isDeleted" = true, "tableToken" = NULL, "tokenVersion" = "tokenVersion" + 1 WHERE id = $1`,
		source); err != nil {
		return 0, dbError(err, "Failed to remove the work table")
	}
	if _, err := tx.Exec(ctx,
		`UPDATE "User" SET "scheduleNote" = COALESCE("scheduleNote", $2), "tableToken" = COALESCE("tableToken", $3) WHERE id = $1`,
		target, note, token); err != nil {
		return 0, dbError(err, "Failed to merge the work table")
	}
	return movedTag.RowsAffected() + managedTag.RowsAffected(), nil
}

type LinkedTech struct {
	ID           string  `db:"id"`
	Username     string  `db:"username"`
	Name         string  `db:"name"`
	Color        string  `db:"color"`
	Note         *string `db:"note"`
	TokenVersion int64   `db:"token_version"`
}

// linkedTech is the tech whose table a link opens.
func (a *App) linkedTech(ctx context.Context, token string) (*LinkedTech, error) {
	tech, err := queryOptional[LinkedTech](ctx, a.DB, `SELECT id, username, color, "scheduleNote" as note, "tokenVersion" as token_version,
            COALESCE((SELECT re.name FROM "RosterEntry" re WHERE re.kind = 'tech' AND re."userId" = "User".id), username) as name
        FROM "User" WHERE "tableToken" = $1 AND NOT "isDeleted"`, token)
	if err != nil {
		return nil, dbError(err, "Failed to load the work table")
	}
	if tech == nil {
		return nil, notFound("Work table not found")
	}
	return tech, nil
}

// asTech: acting through a link is acting as the table's tech, who may only
// touch their own busy time and note.
func asTech(tech *LinkedTech) *AuthUser {
	return &AuthUser{
		SessionID:    nil,
		ID:           tech.ID,
		TokenVersion: tech.TokenVersion,
		Username:     tech.Username,
		Email:        nil,
		Role:         "tech",
	}
}

type RangeQuery struct {
	From *string
	To   *string
}

func parseRangeQuery(r *http.Request) RangeQuery {
	values := r.URL.Query()
	var q RangeQuery
	if values.Has("from") {
		q.From = ptr(values.Get("from"))
	}
	if values.Has("to") {
		q.To = ptr(values.Get("to"))
	}
	return q
}

func (a *App) openTableLink(w http.ResponseWriter, r *http.Request) error {
	token := r.PathValue("token")
	rng := parseRangeQuery(r)
	ctx := r.Context()
	tech, err := a.linkedTech(ctx, token)
	if err != nil {
		return err
	}
	appointments, err := tableLinkSessions(ctx, a.DB, tech.ID, rng.From, rng.To)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"table":        map[string]any{"id": tech.ID, "username": tech.Username, "name": tech.Name, "color": tech.Color, "note": tech.Note},
		"appointments": appointments,
	})
	return nil
}

func (a *App) updateTableLinkNote(w http.ResponseWriter, r *http.Request) error {
	token := r.PathValue("token")
	var payload NotePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	tech, err := a.linkedTech(r.Context(), token)
	if err != nil {
		return err
	}
	return a.saveNote(w, r, tech.ID, payload.Note)
}

// asBlock: busy time through a link is always a block on the linked tech's
// table. payload is the request body as it came (serde_json::Value).
func asBlock(payload json.RawMessage) (AppointmentPayload, error) {
	var out AppointmentPayload
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		// Not an object: serde cannot make the payload of it.
		return out, badRequest("Invalid busy time")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &fields); err != nil {
		return out, badRequest("Invalid busy time")
	}
	fields["isBlock"] = json.RawMessage("true")
	delete(fields, "techId")
	delete(fields, "customerId")
	body, err := json.Marshal(fields)
	if err != nil {
		return out, badRequest("Invalid busy time")
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return AppointmentPayload{}, badRequest("Invalid busy time")
	}
	return out, nil
}

func (a *App) createTableLinkBusy(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	token := r.PathValue("token")
	var payload json.RawMessage
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	tech, err := a.linkedTech(r.Context(), token)
	if err != nil {
		return err
	}
	block, err := asBlock(payload)
	if err != nil {
		return err
	}
	return a.createAppointment(w, r, client, asTech(tech), block)
}

func (a *App) updateTableLinkBusy(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	token, appointmentID := r.PathValue("token"), r.PathValue("id")
	var payload json.RawMessage
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	tech, err := a.linkedTech(r.Context(), token)
	if err != nil {
		return err
	}
	block, err := asBlock(payload)
	if err != nil {
		return err
	}
	return a.updateAppointment(w, r, client, asTech(tech), appointmentID, block)
}

func (a *App) deleteTableLinkBusy(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	token, appointmentID := r.PathValue("token"), r.PathValue("id")
	tech, err := a.linkedTech(r.Context(), token)
	if err != nil {
		return err
	}
	return a.deleteAppointment(w, r, client, asTech(tech), appointmentID)
}

func randomToken(length int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	// Bytes past the last whole multiple of 62 are dropped so every character is as likely.
	limit := byte(256 / len(charset) * len(charset))
	token := make([]byte, 0, length)
	var buf [32]byte
	for len(token) < length {
		if _, err := rand.Read(buf[:]); err != nil {
			panic(err)
		}
		for _, b := range buf {
			if b >= limit {
				continue
			}
			if len(token) == length {
				break
			}
			token = append(token, charset[int(b)%len(charset)])
		}
	}
	return string(token)
}
