package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"
	_ "time/tzdata" // the time zones are in the binary, as chrono-tz's are

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 排班 sessions (场次). Agents and admins plan every tech's sessions openly;
// techs see only their own, read-only, and are notified of changes instead of
// confirming them. A session can open a room owned by its tech, where the
// customer joins through a share link. A session planned by mistake or called
// off is deleted; none is cancelled or completed by hand. A customer is optional.
// Techs mark time they are busy as blocks: theirs alone, without a customer or a
// room, kept out of other sessions' way like any session.
const (
	minDurationMinutes = 5
	maxDurationMinutes = 1440
	maxRangeDays       = 100
	maxFieldChars      = 100
	maxRoomNameChars   = 120
	// unnamedRoom is the name of a session room without a company or position.
	unnamedRoom = "场次"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/appointments", h(a.listAppointments))
		mux.HandleFunc("POST /api/appointments", h(a.createAppointmentRoute))
		mux.HandleFunc("GET /api/appointments/{id}", h(a.getAppointment))
		mux.HandleFunc("PUT /api/appointments/{id}", h(a.updateAppointmentRoute))
		mux.HandleFunc("DELETE /api/appointments/{id}", h(a.deleteAppointmentRoute))
		mux.HandleFunc("POST /api/appointments/{id}/room", h(a.openAppointmentRoom))
	})
}

// a is the session. It reads as completed once its room has ended.
const appointmentSelect = `SELECT a.id, a."startsAt" as starts_at,
    a."durationMinutes" as duration_minutes, a.company, a.position, a.notes, a."isBlock" as is_block,
    CASE WHEN r."isEnded" THEN 'completed' ELSE 'scheduled' END as status,
    a."createdAt" as created_at, a."updatedAt" as updated_at,
    c.id as customer_id, c.name as customer_name, c.contact as customer_contact,
    c.notes as customer_notes, c."isDeleted" as customer_is_deleted,
    ow.id as owner_id, ow.username as owner_username, ow.color as owner_color,
    t.id as tech_id, t.username as tech_username, t.color as tech_color, t.role as tech_role,
    t."isDeleted" as tech_is_deleted,
    cb.id as created_by_id, cb.username as created_by_username, cb.color as created_by_color,
    mg.id as manager_id, mg.username as manager_username, mg.color as manager_color,
    -- Names on the work tables' lists, where the person is on one.
    COALESCE((SELECT re.name FROM "RosterEntry" re WHERE re.kind = 'manager' AND re."userId" = mg.id), mg.username) as manager_name,
    (SELECT re.name FROM "RosterEntry" re WHERE re.kind = 'tech' AND re."userId" = t.id) as tech_name,
    r.id as room_id, r.name as room_name, r.language as room_language, r."isEnded" as room_is_ended,
    r."endedAt" as room_ended_at,
    (a."techId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Appointment" b
        WHERE b.id <> a.id AND b."techId" = a."techId"
          AND b."startsAt" < a."startsAt" + a."durationMinutes" * INTERVAL '1 minute'
          AND a."startsAt" < b."startsAt" + b."durationMinutes" * INTERVAL '1 minute'
    )) as has_conflict
    FROM "Appointment" a
    LEFT JOIN "Customer" c ON c.id = a."customerId"
    LEFT JOIN "User" ow ON ow.id = c."createdBy"
    JOIN "User" cb ON cb.id = a."createdBy"
    -- The 管理 a session belongs to: the one chosen, else its customer's agent, else its planner.
    JOIN "User" mg ON mg.id = COALESCE(a."managerId", c."createdBy", a."createdBy")
    LEFT JOIN "User" t ON t.id = a."techId"
    LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"`

type AppointmentRow struct {
	ID                string     `db:"id"`
	StartsAt          time.Time  `db:"starts_at"`
	DurationMinutes   int32      `db:"duration_minutes"`
	Company           *string    `db:"company"`
	Position          *string    `db:"position"`
	Notes             *string    `db:"notes"`
	IsBlock           bool       `db:"is_block"`
	Status            string     `db:"status"`
	CreatedAt         time.Time  `db:"created_at"`
	UpdatedAt         time.Time  `db:"updated_at"`
	CustomerID        *string    `db:"customer_id"`
	CustomerName      *string    `db:"customer_name"`
	CustomerContact   *string    `db:"customer_contact"`
	CustomerNotes     *string    `db:"customer_notes"`
	CustomerIsDeleted *bool      `db:"customer_is_deleted"`
	OwnerID           *string    `db:"owner_id"`
	OwnerUsername     *string    `db:"owner_username"`
	OwnerColor        *string    `db:"owner_color"`
	TechID            *string    `db:"tech_id"`
	TechUsername      *string    `db:"tech_username"`
	TechColor         *string    `db:"tech_color"`
	TechRole          *string    `db:"tech_role"`
	TechIsDeleted     *bool      `db:"tech_is_deleted"`
	CreatedByID       string     `db:"created_by_id"`
	CreatedByUsername string     `db:"created_by_username"`
	CreatedByColor    string     `db:"created_by_color"`
	ManagerID         string     `db:"manager_id"`
	ManagerUsername   string     `db:"manager_username"`
	ManagerColor      string     `db:"manager_color"`
	ManagerName       string     `db:"manager_name"`
	TechName          *string    `db:"tech_name"`
	RoomID            *string    `db:"room_id"`
	RoomName          *string    `db:"room_name"`
	RoomLanguage      *string    `db:"room_language"`
	RoomIsEnded       *bool      `db:"room_is_ended"`
	RoomEndedAt       *time.Time `db:"room_ended_at"`
	HasConflict       bool       `db:"has_conflict"`
}

// StoredAppointment is the stored session, locked for a change.
type StoredAppointment struct {
	CustomerID      *string   `db:"customer_id"`
	ManagerID       *string   `db:"manager_id"`
	CustomerName    *string   `db:"customer_name"`
	IsBlock         bool      `db:"is_block"`
	TechID          *string   `db:"tech_id"`
	StartsAt        time.Time `db:"starts_at"`
	DurationMinutes int32     `db:"duration_minutes"`
	Company         *string   `db:"company"`
	Position        *string   `db:"position"`
	Notes           *string   `db:"notes"`
	RoomID          *string   `db:"room_id"`
	RoomOwnerID     *string   `db:"room_owner_id"`
	RoomIsLive      *bool     `db:"room_is_live"`
}

type ConflictRow struct {
	ID              string    `db:"id"`
	StartsAt        time.Time `db:"starts_at"`
	DurationMinutes int32     `db:"duration_minutes"`
	CustomerName    *string   `db:"customer_name"`
	ManagerUsername string    `db:"manager_username"`
	IsBlock         bool      `db:"is_block"`
}

type ListAppointmentsQuery struct {
	From       *string
	To         *string
	TechID     *string
	CustomerID *string
	Unassigned bool
	// Staff only: their customers' sessions and the ones they planned.
	Mine bool
}

func parseListAppointmentsQuery(r *http.Request) (*ListAppointmentsQuery, error) {
	values := r.URL.Query()
	query := &ListAppointmentsQuery{}
	var err error
	if query.From, err = scheduleQueryString(values, "from"); err != nil {
		return nil, err
	}
	if query.To, err = scheduleQueryString(values, "to"); err != nil {
		return nil, err
	}
	if query.TechID, err = scheduleQueryString(values, "techId"); err != nil {
		return nil, err
	}
	if query.CustomerID, err = scheduleQueryString(values, "customerId"); err != nil {
		return nil, err
	}
	if query.Unassigned, err = scheduleQueryBool(values, "unassigned"); err != nil {
		return nil, err
	}
	if query.Mine, err = scheduleQueryBool(values, "mine"); err != nil {
		return nil, err
	}
	return query, nil
}

// AppointmentPayload is the body of a new or changed session. It decodes from
// JSON (json.Unmarshal), also for the callers that build the JSON themselves.
type AppointmentPayload struct {
	CustomerID doubleOption[string] `json:"customerId"`
	TechID     doubleOption[string] `json:"techId"`
	// The 管理 the session belongs to (staff only); none falls back to the customer's agent.
	ManagerID       doubleOption[string] `json:"managerId"`
	StartsAt        *string              `json:"startsAt"`
	DurationMinutes *int32               `json:"durationMinutes"`
	Company         doubleOption[string] `json:"company"`
	Position        doubleOption[string] `json:"position"`
	Notes           doubleOption[string] `json:"notes"`
	// Save even if the tech already has a session at that time (staff only).
	AllowConflicts bool `json:"allowConflicts"`
	// Busy time on a tech's table rather than a session (on create).
	IsBlock bool `json:"isBlock"`
}

// UnmarshalJSON decodes the fields and, as serde does, refuses null for the
// two booleans.
func (p *AppointmentPayload) UnmarshalJSON(data []byte) error {
	type fields AppointmentPayload
	var decoded fields
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	for _, key := range []string{"allowConflicts", "isBlock"} {
		if value, ok := raw[key]; ok && strings.TrimSpace(string(value)) == "null" {
			return fmt.Errorf("invalid type: null, expected a boolean for field `%s`", key)
		}
	}
	*p = AppointmentPayload(decoded)
	return nil
}

type AppointmentRoomPayload struct {
	Language *string `json:"language"`
	// Start a new room when the linked one has ended.
	Replace bool `json:"replace"`
}

// sameOptString compares two optional strings as Option<String> == does.
func sameOptString(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// nonEmptyOpt is Option::filter(|id| !id.is_empty()).
func nonEmptyOpt(value *string) *string {
	if value == nil || *value == "" {
		return nil
	}
	return value
}

// listAppointments answers the sessions overlapping [from, to). Techs only
// ever get their own; `mine` keeps a planner's own: their customers' sessions
// and the ones they planned.
func (a *App) listAppointments(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	query, err := parseListAppointmentsQuery(r)
	if err != nil {
		return err
	}
	from, err := parseTime(query.From, "A valid range start is required")
	if err != nil {
		return err
	}
	to, err := parseTime(query.To, "A valid range end is required")
	if err != nil {
		return err
	}
	if !to.After(from) || to.Sub(from) > maxRangeDays*24*time.Hour {
		return badRequest("The range must be between 1 minute and 100 days")
	}
	staff := isStaff(authUser.Role)
	var techID *string
	if staff {
		techID = nonEmptyOpt(query.TechID)
	} else {
		techID = &authUser.ID
	}
	// $1::timestamptz: sqlx declares the parameter's type; pgx leaves it to
	// PostgreSQL, which would take "$1 - INTERVAL" for an interval.
	rows, err := queryAll[AppointmentRow](r.Context(), a.DB, appointmentSelect+`
        WHERE a."startsAt" < $2 AND a."startsAt" > $1::timestamptz - INTERVAL '1 day'
          AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $1
          AND ($3::text IS NULL OR a."techId" = $3)
          AND ($4::text IS NULL OR a."customerId" = $4)
          AND (NOT $5 OR a."techId" IS NULL)
          AND (NOT $6 OR COALESCE(a."managerId", c."createdBy") = $7 OR a."createdBy" = $7)
        ORDER BY a."startsAt", a.id LIMIT 2000`,
		from, to, techID, nonEmptyOpt(query.CustomerID), staff && query.Unassigned, staff && query.Mine, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load sessions")
	}

	list := make([]map[string]any, 0, len(rows))
	for i := range rows {
		list = append(list, appointmentJson(&rows[i], staff))
	}
	writeJSON(w, http.StatusOK, map[string]any{"appointments": list})
	return nil
}

func (a *App) getAppointment(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	appointmentID := r.PathValue("id")
	row, err := loadAppointment(r.Context(), a.DB, appointmentID)
	if err != nil {
		return err
	}
	staff := isStaff(authUser.Role)
	if !staff && !sameOptString(row.TechID, &authUser.ID) {
		return notFound("Appointment not found")
	}
	writeJSON(w, http.StatusOK, map[string]any{"appointment": appointmentJson(row, staff)})
	return nil
}

// createAppointmentRoute is POST /api/appointments. Staff plan sessions for anyone;
// a tech may only mark busy time on their own table.
func (a *App) createAppointmentRoute(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	var payload AppointmentPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	return a.createAppointment(w, r, client, authUser, payload)
}

// createAppointment is create_appointment with its extractors already run:
// the work tables' links call it with the linked tech as the user.
func (a *App) createAppointment(w http.ResponseWriter, r *http.Request, client *ClientInfo, authUser *AuthUser, payload AppointmentPayload) error {
	ctx := r.Context()
	staff := isStaff(authUser.Role)
	isBlock := payload.IsBlock || !staff
	if !staff && !payload.IsBlock {
		// Like every staff-only route, planning does not exist for techs.
		return notFound("Not found")
	}
	customerID := nonEmptyOpt(payload.CustomerID.flatten())
	var techID *string
	if staff {
		techID = payload.TechID.flatten()
	} else {
		techID = ptr(authUser.ID)
	}
	managerID := nonEmptyOpt(payload.ManagerID.flatten())
	if isBlock {
		managerID = nil
	}
	if isBlock && (techID == nil || customerID != nil) {
		return badRequest("Busy time belongs to a tech and has no customer")
	}
	startsAt, err := parseStart(payload.StartsAt)
	if err != nil {
		return err
	}
	requested := int32(60)
	if payload.DurationMinutes != nil {
		requested = *payload.DurationMinutes
	}
	duration, err := checkDuration(requested)
	if err != nil {
		return err
	}
	if err := checkUnsettled(authUser.Role, startsAt, duration); err != nil {
		return err
	}
	var company, position *string
	if !isBlock {
		if company, err = cleanField(payload.Company.flatten(), "Company is too long"); err != nil {
			return err
		}
		if position, err = cleanField(payload.Position.flatten(), "Position is too long"); err != nil {
			return err
		}
	}
	notes, err := cleanText(payload.Notes.flatten(), maxNotesChars, "Notes are too long")
	if err != nil {
		return err
	}
	// Busy time may cover sessions already planned: both show as clashing until someone sorts it out.
	allowConflicts := isBlock || (staff && payload.AllowConflicts)

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	var customerName *string
	if customerID != nil {
		name, err := activeCustomer(ctx, tx, *customerID)
		if err != nil {
			return err
		}
		customerName = &name
	}
	if managerID != nil {
		if err := checkManager(ctx, tx, *managerID); err != nil {
			return err
		}
	}
	if techID != nil {
		if err := checkAssignee(ctx, tx, *techID); err != nil {
			return err
		}
		if err := lockTechSchedule(ctx, tx, *techID); err != nil {
			return err
		}
		if !allowConflicts {
			conflicts, err := findConflicts(ctx, tx, *techID, startsAt, duration, nil)
			if err != nil {
				return err
			}
			if len(conflicts) > 0 {
				conflictResponse(w, conflicts)
				return nil
			}
		}
	}

	appointmentID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "Appointment" (id, "customerId", "techId", "startsAt", "durationMinutes",
            company, position, notes, "createdBy", "isBlock", "managerId")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		appointmentID, customerID, techID, startsAt, duration, company, position, notes,
		authUser.ID, isBlock, managerID); err != nil {
		return dbError(err, "Failed to create session")
	}

	session := Notice{
		appointmentID: appointmentID,
		customerName:  customerName,
		startsAt:      startsAt,
		duration:      duration,
		company:       company,
		position:      position,
	}
	if techID != nil && *techID != authUser.ID && !isBlock {
		if session.isAhead() {
			if err := session.send(ctx, tx, *techID, authUser.ID, noticeAssigned, nil); err != nil {
				return err
			}
		}
	}
	// Customer details are personal data: the audit log keeps IDs and times only.
	if err := recordDetails(ctx, tx, client, "appointment.created", &authUser.ID, &authUser.Username,
		&appointmentID, true, nil, nil, map[string]any{
			"customerId": customerID, "techId": techID, "managerId": managerID, "isBlock": isBlock,
			"startsAt": isoString(startsAt), "durationMinutes": duration,
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	row, err := loadAppointment(ctx, a.DB, appointmentID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"appointment": appointmentJson(row, staff)})
	return nil
}

// updateAppointmentRoute is PUT /api/appointments/{id}.
func (a *App) updateAppointmentRoute(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	appointmentID := r.PathValue("id")
	var payload AppointmentPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	return a.updateAppointment(w, r, client, authUser, appointmentID, payload)
}

const storedAppointmentSQL = `SELECT a."customerId" as customer_id, a."managerId" as manager_id, c.name as customer_name, a."isBlock" as is_block,
            a."techId" as tech_id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, r.id as room_id, r."ownerId" as room_owner_id,
            NOT r."isEnded" as room_is_live
        FROM "Appointment" a LEFT JOIN "Customer" c ON c.id = a."customerId"
        LEFT JOIN "Room" r ON r.id = a."roomId" AND NOT r."isDeleted"
        WHERE a.id = $1 FOR UPDATE OF a`

// updateAppointment is update_appointment with its extractors already run.
func (a *App) updateAppointment(w http.ResponseWriter, r *http.Request, client *ClientInfo, authUser *AuthUser, appointmentID string, payload AppointmentPayload) error {
	ctx := r.Context()
	staff := isStaff(authUser.Role)
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	current, err := queryOptional[StoredAppointment](ctx, tx, storedAppointmentSQL, appointmentID)
	if err != nil {
		return dbError(err, "Failed to load session")
	}
	if current == nil || !(staff || ownBlock(current, authUser.ID)) {
		return notFound("Appointment not found")
	}

	customerID := current.CustomerID
	if payload.CustomerID.Set {
		customerID = nonEmptyOpt(payload.CustomerID.Value)
	}
	techID := current.TechID
	if staff && payload.TechID.Set {
		techID = payload.TechID.Value
	}
	managerID := current.ManagerID
	if payload.ManagerID.Set && staff && !current.IsBlock {
		managerID = nonEmptyOpt(payload.ManagerID.Value)
	}
	if current.IsBlock && (techID == nil || customerID != nil) {
		return badRequest("Busy time belongs to a tech and has no customer")
	}
	startsAt := current.StartsAt
	if payload.StartsAt != nil {
		if startsAt, err = parseStart(payload.StartsAt); err != nil {
			return err
		}
	}
	requested := current.DurationMinutes
	if payload.DurationMinutes != nil {
		requested = *payload.DurationMinutes
	}
	duration, err := checkDuration(requested)
	if err != nil {
		return err
	}
	if err := checkUnsettled(authUser.Role, current.StartsAt, current.DurationMinutes); err != nil {
		return err
	}
	if err := checkUnsettled(authUser.Role, startsAt, duration); err != nil {
		return err
	}
	company := current.Company
	if payload.Company.Set && !current.IsBlock {
		if company, err = cleanField(payload.Company.Value, "Company is too long"); err != nil {
			return err
		}
	}
	position := current.Position
	if payload.Position.Set && !current.IsBlock {
		if position, err = cleanField(payload.Position.Value, "Position is too long"); err != nil {
			return err
		}
	}
	notes := current.Notes
	if payload.Notes.Set {
		if notes, err = cleanText(payload.Notes.Value, maxNotesChars, "Notes are too long"); err != nil {
			return err
		}
	}

	var customerName *string
	switch {
	case customerID == nil:
	case sameOptString(customerID, current.CustomerID):
		customerName = current.CustomerName
	default:
		name, err := activeCustomer(ctx, tx, *customerID)
		if err != nil {
			return err
		}
		customerName = &name
	}
	techChanged := !sameOptString(techID, current.TechID)
	if techID != nil && techChanged {
		if err := checkAssignee(ctx, tx, *techID); err != nil {
			return err
		}
	}
	managerChanged := !sameOptString(managerID, current.ManagerID)
	if managerID != nil && managerChanged {
		if err := checkManager(ctx, tx, *managerID); err != nil {
			return err
		}
	}
	startChanged := !startsAt.Equal(current.StartsAt)
	timeChanged := startChanged || duration != current.DurationMinutes
	companyChanged := !sameOptString(company, current.Company)
	positionChanged := !sameOptString(position, current.Position)
	changes := []string{}
	for _, field := range []struct {
		name    string
		changed bool
	}{
		{"customer", !sameOptString(customerID, current.CustomerID)},
		{"tech", techChanged},
		{"manager", managerChanged},
		{"time", startChanged},
		{"duration", duration != current.DurationMinutes},
		{"company", companyChanged},
		{"position", positionChanged},
		{"notes", !sameOptString(notes, current.Notes)},
	} {
		if field.changed {
			changes = append(changes, field.name)
		}
	}
	if len(changes) == 0 {
		// Saving an unchanged form writes, notifies and records nothing.
		_ = tx.Rollback(context.Background())
		row, err := loadAppointment(ctx, a.DB, appointmentID)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"appointment": appointmentJson(row, staff)})
		return nil
	}
	// Edits that cannot create an overlap, like notes, never trip a conflict saved on purpose.
	mayOverlap := techChanged || timeChanged
	if techID != nil && mayOverlap {
		if err := lockTechSchedule(ctx, tx, *techID); err != nil {
			return err
		}
		if !(current.IsBlock || (staff && payload.AllowConflicts)) {
			conflicts, err := findConflicts(ctx, tx, *techID, startsAt, duration, &appointmentID)
			if err != nil {
				return err
			}
			if len(conflicts) > 0 {
				conflictResponse(w, conflicts)
				return nil
			}
		}
	}

	if _, err := tx.Exec(ctx,
		`UPDATE "Appointment" SET "customerId" = $2, "techId" = $3, "startsAt" = $4,
            "durationMinutes" = $5, company = $6, position = $7, notes = $8, "managerId" = $9,
            "updatedAt" = NOW()
        WHERE id = $1`,
		appointmentID, customerID, techID, startsAt, duration, company, position, notes, managerID); err != nil {
		return dbError(err, "Failed to update session")
	}

	// A live room follows its session: the time and role, the name made of them
	// unless it was renamed by hand, and its new tech as owner.
	if current.RoomID != nil && current.RoomIsLive != nil && *current.RoomIsLive {
		roomID := *current.RoomID
		if timeChanged || companyChanged || positionChanged {
			if _, err := tx.Exec(ctx,
				`UPDATE "Room" SET "scheduledTime" = $2, duration = $3, company = $4, position = $5,
                    name = CASE WHEN name = $6 THEN $7 ELSE name END, "updatedAt" = NOW()
                WHERE id = $1`,
				roomID, startsAt, duration, company, position,
				roomName(current.Company, current.Position), roomName(company, position)); err != nil {
				return dbError(err, "Failed to update the session's room")
			}
		}
		if techID != nil && techChanged {
			newOwner := *techID
			if !sameOptString(current.RoomOwnerID, &newOwner) {
				if err := transferRoom(ctx, tx, roomID, current.RoomOwnerID, newOwner); err != nil {
					return err
				}
				if err := recordDetails(ctx, tx, client, "room.updated", &authUser.ID, &authUser.Username,
					&roomID, true, nil, &roomID, map[string]any{
						"ownerChanged":  map[string]any{"before": current.RoomOwnerID, "after": newOwner},
						"appointmentId": appointmentID,
					}); err != nil {
					return err
				}
			}
		}
	}

	before := Notice{
		appointmentID: appointmentID,
		customerName:  current.CustomerName,
		startsAt:      current.StartsAt,
		duration:      current.DurationMinutes,
		company:       current.Company,
		position:      current.Position,
	}
	after := Notice{
		appointmentID: appointmentID,
		customerName:  customerName,
		startsAt:      startsAt,
		duration:      duration,
		company:       company,
		position:      position,
	}
	// Busy time is the tech's own business: nobody is told about it.
	mine := func(tech string) bool { return tech == authUser.ID || current.IsBlock }
	if techChanged {
		if current.TechID != nil && !mine(*current.TechID) {
			if before.isAhead() {
				if err := before.send(ctx, tx, *current.TechID, authUser.ID, noticeUnassigned, nil); err != nil {
					return err
				}
			}
		}
		if techID != nil && !mine(*techID) {
			if after.isAhead() {
				if err := after.send(ctx, tx, *techID, authUser.ID, noticeAssigned, nil); err != nil {
					return err
				}
			}
		}
	} else if techID != nil && !mine(*techID) {
		// A new 管理 alone is nothing the tech needs to hear about.
		notOnlyManager := slices.ContainsFunc(changes, func(change string) bool { return change != "manager" })
		if (after.isAhead() || before.isAhead()) && notOnlyManager {
			previous := map[string]any{
				"previousStartsAt":        isoString(current.StartsAt),
				"previousDurationMinutes": current.DurationMinutes,
				"changes":                 changes,
			}
			if err := after.send(ctx, tx, *techID, authUser.ID, noticeUpdated, previous); err != nil {
				return err
			}
		}
	}

	if err := recordDetails(ctx, tx, client, "appointment.updated", &authUser.ID, &authUser.Username,
		&appointmentID, true, nil, nil, map[string]any{
			"changes":  changes,
			"techId":   map[string]any{"before": current.TechID, "after": techID},
			"startsAt": isoString(startsAt), "durationMinutes": duration,
			"allowConflicts": payload.AllowConflicts,
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	row, err := loadAppointment(ctx, a.DB, appointmentID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"appointment": appointmentJson(row, staff)})
	return nil
}

// ownBlock: busy time on the caller's own table.
func ownBlock(row *StoredAppointment, userID string) bool {
	return row.IsBlock && row.TechID != nil && *row.TechID == userID
}

// deleteAppointmentRoute is DELETE /api/appointments/{id}.
func (a *App) deleteAppointmentRoute(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	return a.deleteAppointment(w, r, client, authUser, r.PathValue("id"))
}

// deleteAppointment is delete_appointment with its extractors already run.
// It deletes a session planned by mistake or called off; its room, if any,
// stays as it is. A tech losing a session still to come is told it was
// cancelled.
func (a *App) deleteAppointment(w http.ResponseWriter, r *http.Request, client *ClientInfo, authUser *AuthUser, appointmentID string) error {
	ctx := r.Context()
	staff := isStaff(authUser.Role)
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	var startsAt time.Time
	var duration int32
	err = tx.QueryRow(ctx,
		`SELECT "startsAt", "durationMinutes" FROM "Appointment" WHERE id = $1 FOR UPDATE`,
		appointmentID).Scan(&startsAt, &duration)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
	case err != nil:
		return dbError(err, "Failed to load session")
	default:
		if err := checkUnsettled(authUser.Role, startsAt, duration); err != nil {
			return err
		}
	}
	// Techs delete only their own busy time.
	current, err := queryOptional[StoredAppointment](ctx, tx,
		`DELETE FROM "Appointment" a
        WHERE a.id = $1 AND ($2 OR (a."isBlock" AND a."techId" = $3))
        RETURNING a."customerId" as customer_id, a."managerId" as manager_id,
            (SELECT c.name FROM "Customer" c WHERE c.id = a."customerId") as customer_name,
            a."isBlock" as is_block, a."techId" as tech_id,
            a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            a.company, a.position, a.notes, a."roomId" as room_id,
            NULL::text as room_owner_id, NULL::boolean as room_is_live`,
		appointmentID, staff, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to delete session")
	}
	if current == nil {
		return notFound("Appointment not found")
	}

	session := Notice{
		appointmentID: appointmentID,
		customerName:  current.CustomerName,
		startsAt:      current.StartsAt,
		duration:      current.DurationMinutes,
		company:       current.Company,
		position:      current.Position,
	}
	if current.TechID != nil && *current.TechID != authUser.ID && !current.IsBlock {
		if session.isAhead() {
			if err := session.send(ctx, tx, *current.TechID, authUser.ID, noticeCancelled, nil); err != nil {
				return err
			}
		}
	}
	if err := recordDetails(ctx, tx, client, "appointment.deleted", &authUser.ID, &authUser.Username,
		&appointmentID, true, nil, current.RoomID, map[string]any{
			"customerId": current.CustomerID, "techId": current.TechID,
			"startsAt": isoString(current.StartsAt),
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	writeJSON(w, http.StatusOK, map[string]any{"message": "Session deleted"})
	return nil
}

// openAppointmentRoom opens the session's room, creating it on first use with
// the tech as owner and the session's time, company and position. The assigned
// tech and staff may call this; an unassigned session's room belongs to the
// staff member who opens it.
func (a *App) openAppointmentRoom(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	appointmentID := r.PathValue("id")
	var payload AppointmentRoomPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()
	staff := isStaff(authUser.Role)
	language := "javascript"
	if payload.Language != nil {
		language = *payload.Language
	}
	if !slices.Contains(supportedLanguages[:], language) {
		return badRequest("Unsupported language")
	}
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	current, err := queryOptional[StoredAppointment](ctx, tx, storedAppointmentSQL, appointmentID)
	if err != nil {
		return dbError(err, "Failed to load session")
	}
	if current == nil || current.IsBlock || !(staff || sameOptString(current.TechID, &authUser.ID)) {
		return notFound("Appointment not found")
	}

	if current.RoomID != nil {
		if (current.RoomIsLive != nil && *current.RoomIsLive) || !payload.Replace {
			_ = tx.Rollback(context.Background())
			row, err := loadAppointment(ctx, a.DB, appointmentID)
			if err != nil {
				return err
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"room":        map[string]any{"id": *current.RoomID},
				"appointment": appointmentJson(row, staff),
				"created":     false,
			})
			return nil
		}
	}
	techIsActive := false
	if current.TechID != nil {
		if techIsActive, err = isActiveUser(ctx, tx, *current.TechID); err != nil {
			return err
		}
	}
	var ownerID string
	switch {
	case current.TechID != nil && techIsActive:
		ownerID = *current.TechID
	case staff:
		ownerID = authUser.ID
	default:
		return notFound("Appointment not found")
	}
	name := roomName(current.Company, current.Position)
	room, err := insertRoom(ctx, tx, NewRoom{
		Name:          name,
		Language:      language,
		Company:       current.Company,
		Position:      current.Position,
		OwnerID:       ownerID,
		ScheduledTime: &current.StartsAt,
		Duration:      &current.DurationMinutes,
		IsPrivate:     false,
	})
	if err != nil {
		return err
	}
	// A session whose room ended reads as scheduled again with the new one.
	if _, err := tx.Exec(ctx,
		`UPDATE "Appointment" SET "roomId" = $2, "updatedAt" = NOW() WHERE id = $1`,
		appointmentID, room.ID); err != nil {
		return dbError(err, "Failed to link the room")
	}
	if err := recordDetails(ctx, tx, client, "room.created", &authUser.ID, &authUser.Username,
		&room.ID, true, nil, &room.ID, map[string]any{
			"isPrivate": false, "language": language, "appointmentId": appointmentID,
			"ownerId": ownerID, "replaces": current.RoomID,
		}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("session room created",
		"actor_id", authUser.ID, "room_id", room.ID, "appointment_id", appointmentID, "owner_id", ownerID)

	row, err := loadAppointment(ctx, a.DB, appointmentID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"room":        roomToJsonOwner(room),
		"appointment": appointmentJson(row, staff),
		"created":     true,
	})
	return nil
}

// tableLinkSessions answers the sessions and busy time on one tech's table,
// for its link: who booked (the 管理), when, company, position and notes.
// Never the customer.
func tableLinkSessions(ctx context.Context, db DBTX, techID string, from, to *string) ([]map[string]any, error) {
	fromTime, err := parseTime(from, "A valid range start is required")
	if err != nil {
		return nil, err
	}
	toTime, err := parseTime(to, "A valid range end is required")
	if err != nil {
		return nil, err
	}
	if !toTime.After(fromTime) || toTime.Sub(fromTime) > maxRangeDays*24*time.Hour {
		return nil, badRequest("The range must be between 1 minute and 100 days")
	}
	// $1::timestamptz: see listAppointments.
	rows, err := queryAll[AppointmentRow](ctx, db, appointmentSelect+`
        WHERE a."techId" = $3 AND a."startsAt" < $2 AND a."startsAt" > $1::timestamptz - INTERVAL '1 day'
          AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $1
        ORDER BY a."startsAt", a.id LIMIT 2000`,
		fromTime, toTime, techID)
	if err != nil {
		return nil, dbError(err, "Failed to load sessions")
	}
	sessions := make([]map[string]any, 0, len(rows))
	for i := range rows {
		row := &rows[i]
		var agent any
		if !row.IsBlock {
			agent = managerJson(row)
		}
		sessions = append(sessions, map[string]any{
			"id":              row.ID,
			"startsAt":        isoString(row.StartsAt),
			"endsAt":          isoString(endsAt(row.StartsAt, row.DurationMinutes)),
			"durationMinutes": row.DurationMinutes,
			"company":         row.Company,
			"position":        row.Position,
			"notes":           row.Notes,
			"isBlock":         row.IsBlock,
			"status":          row.Status,
			"customer":        nil,
			"tech":            appointmentTechJson(row),
			"room":            nil,
			"hasConflict":     row.HasConflict,
			"manager":         agent,
			"createdBy":       agent,
			"createdAt":       isoString(row.CreatedAt),
			"updatedAt":       isoString(row.UpdatedAt),
		})
	}
	return sessions, nil
}

// appointmentTechJson is the "tech" of a session: null when unassigned.
func appointmentTechJson(row *AppointmentRow) any {
	if row.TechID == nil {
		return nil
	}
	name := row.TechName
	if name == nil {
		name = row.TechUsername
	}
	return map[string]any{
		"id":        *row.TechID,
		"username":  row.TechUsername,
		"name":      name,
		"color":     row.TechColor,
		"role":      row.TechRole,
		"isDeleted": row.TechIsDeleted != nil && *row.TechIsDeleted,
	}
}

func appointmentJson(row *AppointmentRow, staff bool) map[string]any {
	var customer any
	if row.CustomerID != nil {
		fields := map[string]any{
			"id":        *row.CustomerID,
			"name":      row.CustomerName,
			"isDeleted": row.CustomerIsDeleted != nil && *row.CustomerIsDeleted,
			// The agent the customer belongs to.
			"owner": map[string]any{"id": row.OwnerID, "username": row.OwnerUsername, "color": row.OwnerColor},
		}
		// The profile stays with agents: techs meet customers through the session's
		// room, and the session's own notes are the ones written for its tech.
		if staff {
			fields["contact"] = row.CustomerContact
			fields["notes"] = row.CustomerNotes
		}
		customer = fields
	}
	var room any
	if row.RoomID != nil {
		room = map[string]any{
			"id":       *row.RoomID,
			"name":     row.RoomName,
			"language": row.RoomLanguage,
			"isEnded":  row.RoomIsEnded != nil && *row.RoomIsEnded,
			"endedAt":  isoStringOpt(row.RoomEndedAt),
		}
	}
	var manager any
	if !row.IsBlock {
		manager = managerJson(row)
	}
	return map[string]any{
		"id":              row.ID,
		"startsAt":        isoString(row.StartsAt),
		"endsAt":          isoString(endsAt(row.StartsAt, row.DurationMinutes)),
		"durationMinutes": row.DurationMinutes,
		"company":         row.Company,
		"position":        row.Position,
		"notes":           row.Notes,
		"isBlock":         row.IsBlock,
		"status":          row.Status,
		"customer":        customer,
		"tech":            appointmentTechJson(row),
		"room":            room,
		"hasConflict":     row.HasConflict,
		"manager":         manager,
		"createdBy":       map[string]any{"id": row.CreatedByID, "username": row.CreatedByUsername, "color": row.CreatedByColor},
		"createdAt":       isoString(row.CreatedAt),
		"updatedAt":       isoString(row.UpdatedAt),
	}
}

// managerJson is the 管理 a session belongs to: the one chosen, else its
// customer's agent, else its planner.
func managerJson(row *AppointmentRow) map[string]any {
	return map[string]any{"id": row.ManagerID, "username": row.ManagerUsername, "name": row.ManagerName, "color": row.ManagerColor}
}

func loadAppointment(ctx context.Context, db DBTX, appointmentID string) (*AppointmentRow, error) {
	row, err := queryOptional[AppointmentRow](ctx, db, appointmentSelect+" WHERE a.id = $1", appointmentID)
	if err != nil {
		return nil, dbError(err, "Failed to load session")
	}
	if row == nil {
		return nil, notFound("Appointment not found")
	}
	return row, nil
}

func activeCustomer(ctx context.Context, tx DBTX, customerID string) (string, error) {
	name, err := scalarOptional[string](ctx, tx,
		`SELECT name FROM "Customer" WHERE id = $1 AND NOT "isDeleted"`, customerID)
	if err != nil {
		return "", dbError(err, "Failed to load customer")
	}
	if name == nil {
		return "", badRequest("Customer not found")
	}
	return *name, nil
}

func isActiveUser(ctx context.Context, tx DBTX, userID string) (bool, error) {
	role, err := accountRole(ctx, tx, userID)
	if err != nil {
		return false, err
	}
	return role != nil, nil
}

func accountRole(ctx context.Context, tx DBTX, userID string) (*string, error) {
	role, err := scalarOptional[string](ctx, tx, `SELECT role FROM "User" WHERE id = $1 AND NOT "isDeleted"`, userID)
	if err != nil {
		return nil, dbError(err, "Failed to load account")
	}
	return role, nil
}

// checkAssignee: sessions usually go to techs, but any active account can take one.
func checkAssignee(ctx context.Context, tx DBTX, userID string) error {
	role, err := accountRole(ctx, tx, userID)
	if err != nil {
		return err
	}
	if role == nil {
		return badRequest("Invalid tech")
	}
	return nil
}

// checkManager: a session's 管理 is an agent or admin with an account.
func checkManager(ctx context.Context, tx DBTX, userID string) error {
	role, err := accountRole(ctx, tx, userID)
	if err != nil {
		return err
	}
	if role == nil || !isStaff(*role) {
		return badRequest("Invalid manager")
	}
	return nil
}

// lockTechSchedule serializes changes to one tech's sessions so two planners
// cannot double-book them.
func lockTechSchedule(ctx context.Context, tx DBTX, techID string) error {
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "schedule:"+techID); err != nil {
		return dbError(err, "Failed to lock the schedule")
	}
	return nil
}

func findConflicts(ctx context.Context, tx DBTX, techID string, startsAt time.Time, duration int32, except *string) ([]ConflictRow, error) {
	conflicts, err := queryAll[ConflictRow](ctx, tx,
		`SELECT a.id, a."startsAt" as starts_at, a."durationMinutes" as duration_minutes,
            c.name as customer_name, COALESCE(re.name, mg.username) as manager_username, a."isBlock" as is_block
        FROM "Appointment" a LEFT JOIN "Customer" c ON c.id = a."customerId"
        JOIN "User" mg ON mg.id = COALESCE(a."managerId", c."createdBy", a."createdBy")
        LEFT JOIN "RosterEntry" re ON re.kind = 'manager' AND re."userId" = mg.id
        WHERE a."techId" = $1 AND ($4::text IS NULL OR a.id <> $4)
          AND a."startsAt" < $3 AND a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > $2
        ORDER BY a."startsAt", a.id LIMIT 20`,
		techID, startsAt, endsAt(startsAt, duration), except)
	if err != nil {
		return nil, dbError(err, "Failed to check the schedule")
	}
	return conflicts, nil
}

// conflictResponse answers 409 with the sessions in the way.
func conflictResponse(w http.ResponseWriter, conflicts []ConflictRow) {
	list := make([]map[string]any, 0, len(conflicts))
	for _, conflict := range conflicts {
		var customer any
		if conflict.CustomerName != nil {
			customer = map[string]any{"name": *conflict.CustomerName}
		}
		list = append(list, map[string]any{
			"id":              conflict.ID,
			"startsAt":        isoString(conflict.StartsAt),
			"endsAt":          isoString(endsAt(conflict.StartsAt, conflict.DurationMinutes)),
			"durationMinutes": conflict.DurationMinutes,
			"customer":        customer,
			"manager":         map[string]any{"username": conflict.ManagerUsername},
			"createdBy":       map[string]any{"username": conflict.ManagerUsername},
			"isBlock":         conflict.IsBlock,
		})
	}
	writeJSON(w, http.StatusConflict, map[string]any{"error": "Schedule conflict", "conflicts": list})
}

// transferRoom: the new tech owns the room; the previous owner stays a member
// of it.
func transferRoom(ctx context.Context, tx DBTX, roomID string, previousOwner *string, newOwner string) error {
	if _, err := tx.Exec(ctx, `UPDATE "Room" SET "ownerId" = $2, "updatedAt" = NOW() WHERE id = $1`,
		roomID, newOwner); err != nil {
		return dbError(err, "Failed to transfer the room")
	}
	if previousOwner != nil {
		// The previous tech keeps the room: they still edit it while it is live
		// and can replay it after it ends. No share link backs this membership,
		// so removing a link they once joined through does not take it away.
		if _, err := tx.Exec(ctx,
			`INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit", "canReplay") VALUES ($1, $2, $3, true, true)
            ON CONFLICT ("roomId", "userId") DO UPDATE SET "canEdit" = true, "canReplay" = true, "shareLinkId" = NULL`,
			uuid.NewString(), roomID, *previousOwner); err != nil {
			return dbError(err, "Failed to transfer the room")
		}
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO "RoomParticipant" (id, "roomId", "userId", "canEdit") VALUES ($1, $2, $3, true)
        ON CONFLICT ("roomId", "userId") DO UPDATE SET "canEdit" = true`,
		uuid.NewString(), roomID, newOwner); err != nil {
		return dbError(err, "Failed to transfer the room")
	}
	return nil
}

type NoticeKind int

const (
	noticeAssigned NoticeKind = iota
	noticeUpdated
	noticeUnassigned
	noticeCancelled
)

func (k NoticeKind) kind() string {
	switch k {
	case noticeAssigned:
		return "schedule.assigned"
	case noticeUpdated:
		return "schedule.updated"
	case noticeUnassigned:
		return "schedule.unassigned"
	default:
		return "schedule.cancelled"
	}
}

// title: clients render notices from kind and data; this text is for older
// clients.
func (k NoticeKind) title() string {
	switch k {
	case noticeAssigned:
		return "New session assigned"
	case noticeUpdated:
		return "Session changed"
	case noticeUnassigned:
		return "Session reassigned"
	default:
		return "Session cancelled"
	}
}

// Notice is a session as its tech is told about it.
type Notice struct {
	appointmentID string
	customerName  *string
	startsAt      time.Time
	duration      int32
	company       *string
	position      *string
}

// isAhead: techs hear about sessions that have not finished yet, not past ones.
func (n *Notice) isAhead() bool {
	return endsAt(n.startsAt, n.duration).After(time.Now())
}

func (n *Notice) send(ctx context.Context, tx DBTX, recipient, actor string, kind NoticeKind, extra map[string]any) error {
	data := map[string]any{
		"appointmentId":   n.appointmentID,
		"customerName":    n.customerName,
		"startsAt":        isoString(n.startsAt),
		"durationMinutes": n.duration,
		"company":         n.company,
		"position":        n.position,
	}
	for key, value := range extra {
		data[key] = value
	}
	var title string
	if n.customerName != nil {
		title = *n.customerName
	} else {
		title = roomName(n.company, n.position)
	}
	content := fmt.Sprintf("%s · %s UTC · %d min", title, n.startsAt.UTC().Format("2006-01-02 15:04"), n.duration)
	return notify(ctx, tx, recipient, actor, kind.kind(), kind.title(), content, data)
}

func endsAt(startsAt time.Time, duration int32) time.Time {
	return startsAt.Add(time.Duration(duration) * time.Minute)
}

func parseTime(value *string, message string) (time.Time, error) {
	if value == nil {
		return time.Time{}, badRequest(message)
	}
	text := []byte(strings.TrimSpace(*value))
	// chrono also reads "t" or a space between date and time, and "z".
	if len(text) > 10 && (text[10] == 't' || text[10] == ' ') {
		text[10] = 'T'
	}
	if n := len(text); n > 0 && text[n-1] == 'z' {
		text[n-1] = 'Z'
	}
	parsed, err := time.Parse(time.RFC3339Nano, string(text))
	if err != nil {
		return time.Time{}, badRequest(message)
	}
	parsed = parsed.UTC()
	if year := parsed.Year(); year < 2000 || year > 2100 {
		return time.Time{}, badRequest(message)
	}
	return parsed, nil
}

// parseStart: start times carry their UTC offset and are kept to the minute.
func parseStart(value *string) (time.Time, error) {
	start, err := parseTime(value, "A valid start time is required")
	if err != nil {
		return time.Time{}, err
	}
	return start.Truncate(time.Minute), nil
}

// settledAfterHours: hours after its end a session is settled: from then on
// only 超级管理员 plan, change or delete it (busy time included).
const settledAfterHours = 12

func checkUnsettled(role string, startsAt time.Time, duration int32) error {
	settled := startsAt.Add(time.Duration(duration)*time.Minute + settledAfterHours*time.Hour).Before(time.Now())
	if settled && !isAdmin(role) {
		return forbidden("Past sessions are locked")
	}
	return nil
}

func checkDuration(minutes int32) (int32, error) {
	if minutes >= minDurationMinutes && minutes <= maxDurationMinutes {
		return minutes, nil
	}
	return 0, badRequest("Duration must be between 5 minutes and 24 hours")
}

func cleanField(value *string, tooLong string) (*string, error) {
	return cleanText(value, maxFieldChars, tooLong)
}

// roomName is "Company Position", kept within the room name limit. The
// customer's name stays out of it.
func roomName(company, position *string) string {
	parts := make([]string, 0, 2)
	for _, part := range []*string{company, position} {
		if part != nil {
			parts = append(parts, *part)
		}
	}
	name := strings.Join(parts, " ")
	if name == "" {
		return unnamedRoom
	}
	if runes := []rune(name); len(runes) > maxRoomNameChars {
		return string(runes[:maxRoomNameChars])
	}
	return name
}
