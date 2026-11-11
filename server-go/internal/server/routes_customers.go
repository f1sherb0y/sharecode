package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// 排班 customer profiles: one list shared by every agent and admin, where each
// customer belongs to the agent who created it. Customers never sign in, and
// techs only see the customer of their own sessions.
const (
	maxNameChars    = 100
	maxContactChars = 200
	maxNotesChars   = 2000
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/customers", h(a.listCustomers))
		mux.HandleFunc("POST /api/customers", h(a.createCustomer))
		mux.HandleFunc("GET /api/customers/{id}", h(a.getCustomer))
		mux.HandleFunc("PUT /api/customers/{id}", h(a.updateCustomer))
		mux.HandleFunc("DELETE /api/customers/{id}", h(a.deleteCustomer))
	})
}

// doubleOption tells an absent field (Set false) from an explicit null (Set
// true, Value nil) in updates: serde's double_option.
type doubleOption[T any] struct {
	Set   bool
	Value *T
}

func (d *doubleOption[T]) UnmarshalJSON(data []byte) error {
	d.Set = true
	d.Value = nil
	if strings.TrimSpace(string(data)) == "null" {
		return nil
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	d.Value = &value
	return nil
}

// flatten is Option<Option<T>>::flatten: the value, nil when absent or null.
func (d doubleOption[T]) flatten() *T {
	if !d.Set {
		return nil
	}
	return d.Value
}

// cleanText trims optional text, treating blank as none, and rejects it past
// max characters.
func cleanText(value *string, max int, tooLong string) (*string, error) {
	if value == nil {
		return nil, nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(trimmed) > max {
		return nil, badRequest(tooLong)
	}
	return &trimmed, nil
}

func cleanName(value *string) (string, error) {
	name, err := cleanText(value, maxNameChars, "Customer name is too long")
	if err != nil {
		return "", err
	}
	if name == nil {
		return "", badRequest("Customer name is required")
	}
	return *name, nil
}

type CustomerListQuery struct {
	Page     *uint32
	PageSize *uint32
	Q        *string
	// Only the caller's own customers: the ones they created.
	Mine bool
}

// scheduleQueryString reads an optional query value as serde does: a missing
// key is none, a repeated one is rejected.
func scheduleQueryString(values url.Values, key string) (*string, error) {
	found := values[key]
	switch len(found) {
	case 0:
		return nil, nil
	case 1:
		return &found[0], nil
	}
	return nil, queryRejection(fmt.Errorf("duplicate field `%s`", key))
}

// scheduleQueryBool reads a boolean that defaults to false and is exactly
// `true` or `false` when present.
func scheduleQueryBool(values url.Values, key string) (bool, error) {
	value, err := scheduleQueryString(values, key)
	if err != nil || value == nil {
		return false, err
	}
	switch *value {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, queryRejection(errors.New("provided string was not `true` or `false`"))
}

func scheduleQueryUint32(values url.Values, key string) (*uint32, error) {
	value, err := scheduleQueryString(values, key)
	if err != nil || value == nil {
		return nil, err
	}
	n, err := strconv.ParseUint(*value, 10, 32)
	if err != nil {
		return nil, queryRejection(err)
	}
	return ptr(uint32(n)), nil
}

func parseCustomerListQuery(r *http.Request) (*CustomerListQuery, error) {
	values := r.URL.Query()
	query := &CustomerListQuery{}
	var err error
	if query.Page, err = scheduleQueryUint32(values, "page"); err != nil {
		return nil, err
	}
	if query.PageSize, err = scheduleQueryUint32(values, "pageSize"); err != nil {
		return nil, err
	}
	if query.Q, err = scheduleQueryString(values, "q"); err != nil {
		return nil, err
	}
	if query.Mine, err = scheduleQueryBool(values, "mine"); err != nil {
		return nil, err
	}
	return query, nil
}

type CreateCustomerPayload struct {
	Name    *string `json:"name"`
	Contact *string `json:"contact"`
	Notes   *string `json:"notes"`
}

type UpdateCustomerPayload struct {
	Name    *string              `json:"name"`
	Contact doubleOption[string] `json:"contact"`
	Notes   doubleOption[string] `json:"notes"`
}

type CustomerRow struct {
	ID                string     `db:"id"`
	Name              string     `db:"name"`
	Contact           *string    `db:"contact"`
	Notes             *string    `db:"notes"`
	CreatedAt         time.Time  `db:"created_at"`
	UpdatedAt         time.Time  `db:"updated_at"`
	CreatedByID       string     `db:"created_by_id"`
	CreatedByUsername string     `db:"created_by_username"`
	SessionCount      int64      `db:"session_count"`
	UpcomingCount     int64      `db:"upcoming_count"`
	NextSessionAt     *time.Time `db:"next_session_at"`
	LastSessionAt     *time.Time `db:"last_session_at"`
}

// c is the customer. Sessions still to come are those that have not ended yet.
const customerSelect = `SELECT c.id, c.name, c.contact, c.notes,
    c."createdAt" as created_at, c."updatedAt" as updated_at,
    cb.id as created_by_id, cb.username as created_by_username,
    s.session_count, s.upcoming_count, s.next_session_at, s.last_session_at
    FROM "Customer" c JOIN "User" cb ON cb.id = c."createdBy"
    LEFT JOIN LATERAL (
        SELECT COUNT(*) as session_count,
            COUNT(*) FILTER (WHERE a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW())
                as upcoming_count,
            MIN(a."startsAt") FILTER (WHERE a."startsAt" + a."durationMinutes" * INTERVAL '1 minute' > NOW())
                as next_session_at,
            MAX(a."startsAt") FILTER (WHERE a."startsAt" <= NOW()) as last_session_at
        FROM "Appointment" a WHERE a."customerId" = c.id
    ) s ON true`

func (a *App) listCustomers(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	query, err := parseCustomerListQuery(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	pattern := searchPattern(query.Q)
	total, err := scalar[int64](ctx, a.DB,
		`SELECT COUNT(*) FROM "Customer" c
        WHERE NOT c."isDeleted" AND (c.name ILIKE $1 OR COALESCE(c.contact, '') ILIKE $1)
          AND (NOT $2 OR c."createdBy" = $3)`,
		pattern, query.Mine, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to count customers")
	}
	pageSize := uint32(25)
	if query.PageSize != nil {
		pageSize = *query.PageSize
	}
	size := int64(min(max(pageSize, 1), 100))
	pages := (total + size - 1) / size
	pageNumber := uint32(1)
	if query.Page != nil {
		pageNumber = *query.Page
	}
	page := min(int64(max(pageNumber, 1)), max(pages, 1))
	customers, err := queryAll[CustomerRow](ctx, a.DB, customerSelect+`
        WHERE NOT c."isDeleted" AND (c.name ILIKE $1 OR COALESCE(c.contact, '') ILIKE $1)
          AND (NOT $4 OR c."createdBy" = $5)
        ORDER BY lower(c.name), c.id LIMIT $2 OFFSET $3`,
		pattern, size, (page-1)*size, query.Mine, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load customers")
	}

	list := make([]map[string]any, 0, len(customers))
	for i := range customers {
		list = append(list, customerJson(&customers[i]))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"customers": list,
		"pagination": map[string]any{
			"page": page, "pageSize": size, "total": total, "totalPages": pages,
			"hasNext": page < pages, "hasPrev": page > 1,
		},
	})
	return nil
}

// getCustomer answers a customer with their sessions, newest first.
func (a *App) getCustomer(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.staffUser(r); err != nil {
		return err
	}
	customerID := r.PathValue("id")
	ctx := r.Context()
	customer, err := loadCustomer(ctx, a.DB, customerID)
	if err != nil {
		return err
	}
	appointments, err := queryAll[AppointmentRow](ctx, a.DB,
		appointmentSelect+` WHERE a."customerId" = $1 ORDER BY a."startsAt" DESC, a.id LIMIT 200`,
		customerID)
	if err != nil {
		return dbError(err, "Failed to load sessions")
	}

	list := make([]map[string]any, 0, len(appointments))
	for i := range appointments {
		list = append(list, appointmentJson(&appointments[i], true))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"customer":     customerJson(customer),
		"appointments": list,
	})
	return nil
}

func (a *App) createCustomer(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	var payload CreateCustomerPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	name, err := cleanName(payload.Name)
	if err != nil {
		return err
	}
	contact, err := cleanText(payload.Contact, maxContactChars, "Contact is too long")
	if err != nil {
		return err
	}
	notes, err := cleanText(payload.Notes, maxNotesChars, "Notes are too long")
	if err != nil {
		return err
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	customerID := uuid.NewString()
	if _, err := tx.Exec(ctx,
		`INSERT INTO "Customer" (id, name, contact, notes, "createdBy") VALUES ($1, $2, $3, $4, $5)`,
		customerID, name, contact, notes, authUser.ID); err != nil {
		return dbError(err, "Failed to create customer")
	}
	// Names, contacts and notes are personal data: the audit log records IDs only.
	if err := recordDetails(ctx, tx, client, "customer.created", &authUser.ID, &authUser.Username,
		&customerID, true, nil, nil, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	customer, err := loadCustomer(ctx, a.DB, customerID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"customer": customerJson(customer)})
	return nil
}

func (a *App) updateCustomer(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	customerID := r.PathValue("id")
	var payload UpdateCustomerPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	var name *string
	if payload.Name != nil {
		cleaned, err := cleanName(payload.Name)
		if err != nil {
			return err
		}
		name = &cleaned
	}
	var contact, notes *string
	if payload.Contact.Set {
		if contact, err = cleanText(payload.Contact.Value, maxContactChars, "Contact is too long"); err != nil {
			return err
		}
	}
	if payload.Notes.Set {
		if notes, err = cleanText(payload.Notes.Value, maxNotesChars, "Notes are too long"); err != nil {
			return err
		}
	}
	changes := []string{}
	if name != nil {
		changes = append(changes, "name")
	}
	if payload.Contact.Set {
		changes = append(changes, "contact")
	}
	if payload.Notes.Set {
		changes = append(changes, "notes")
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	updated, err := scalarOptional[string](ctx, tx,
		`UPDATE "Customer" SET name = COALESCE($2, name),
            contact = CASE WHEN $3 THEN $4 ELSE contact END,
            notes = CASE WHEN $5 THEN $6 ELSE notes END,
            "updatedAt" = NOW()
        WHERE id = $1 AND NOT "isDeleted" RETURNING id`,
		customerID, name, payload.Contact.Set, contact, payload.Notes.Set, notes)
	if err != nil {
		return dbError(err, "Failed to update customer")
	}
	if updated == nil {
		return notFound("Customer not found")
	}
	if err := recordDetails(ctx, tx, client, "customer.updated", &authUser.ID, &authUser.Username,
		&customerID, true, nil, nil, map[string]any{"changes": changes}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	customer, err := loadCustomer(ctx, a.DB, customerID)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, map[string]any{"customer": customerJson(customer)})
	return nil
}

// deleteCustomer removes a customer from the list. Past sessions keep their
// name; one with sessions still to come must have them moved or deleted first.
func (a *App) deleteCustomer(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.staffUser(r)
	if err != nil {
		return err
	}
	customerID := r.PathValue("id")

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	found, err := scalarOptional[string](ctx, tx,
		`SELECT id FROM "Customer" WHERE id = $1 AND NOT "isDeleted" FOR UPDATE`, customerID)
	if err != nil {
		return dbError(err, "Failed to load customer")
	}
	if found == nil {
		return notFound("Customer not found")
	}
	upcoming, err := scalar[int64](ctx, tx,
		`SELECT COUNT(*) FROM "Appointment"
        WHERE "customerId" = $1 AND "startsAt" + "durationMinutes" * INTERVAL '1 minute' > NOW()`,
		customerID)
	if err != nil {
		return dbError(err, "Failed to check sessions")
	}
	if upcoming > 0 {
		return conflict("Customer has upcoming sessions")
	}
	if _, err := tx.Exec(ctx,
		`UPDATE "Customer" SET "isDeleted" = true, "updatedAt" = NOW() WHERE id = $1`, customerID); err != nil {
		return dbError(err, "Failed to delete customer")
	}
	if err := recordDetails(ctx, tx, client, "customer.deleted", &authUser.ID, &authUser.Username,
		&customerID, true, nil, nil, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	writeJSON(w, http.StatusOK, map[string]any{"message": "Customer deleted"})
	return nil
}

func loadCustomer(ctx context.Context, db DBTX, customerID string) (*CustomerRow, error) {
	customer, err := queryOptional[CustomerRow](ctx, db,
		customerSelect+` WHERE c.id = $1 AND NOT c."isDeleted"`, customerID)
	if err != nil {
		return nil, dbError(err, "Failed to load customer")
	}
	if customer == nil {
		return nil, notFound("Customer not found")
	}
	return customer, nil
}

func customerJson(customer *CustomerRow) map[string]any {
	return map[string]any{
		"id":            customer.ID,
		"name":          customer.Name,
		"contact":       customer.Contact,
		"notes":         customer.Notes,
		"createdAt":     isoString(customer.CreatedAt),
		"updatedAt":     isoString(customer.UpdatedAt),
		"createdBy":     map[string]any{"id": customer.CreatedByID, "username": customer.CreatedByUsername},
		"sessionCount":  customer.SessionCount,
		"upcomingCount": customer.UpcomingCount,
		"nextSessionAt": isoStringOpt(customer.NextSessionAt),
		"lastSessionAt": isoStringOpt(customer.LastSessionAt),
	}
}
