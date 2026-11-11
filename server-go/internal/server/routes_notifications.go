package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/notifications", h(a.listNotifications))
		mux.HandleFunc("GET /api/notifications/unread", h(a.listUnreadNotifications))
		mux.HandleFunc("POST /api/notifications/read-all", h(a.markAllNotificationsRead))
		mux.HandleFunc("POST /api/notifications/read", h(a.markNotificationsRead))
		mux.HandleFunc("POST /api/admin/notifications", h(a.createNotification))
	})
}

type CreateNotificationPayload struct {
	Title    *string `json:"title"`
	Content  *string `json:"content"`
	Severity *string `json:"severity"`
}

// MarkNotificationsReadPayload: ids defaults to none when absent; null is
// not a list, as for serde.
type MarkNotificationsReadPayload struct {
	IDs []string
}

func (p *MarkNotificationsReadPayload) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return &json.UnmarshalTypeError{Value: "null", Type: reflect.TypeFor[MarkNotificationsReadPayload]()}
	}
	var raw struct {
		IDs json.RawMessage `json:"ids"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	p.IDs = []string{}
	if raw.IDs == nil {
		return nil
	}
	if bytes.Equal(bytes.TrimSpace(raw.IDs), []byte("null")) {
		return &json.UnmarshalTypeError{Value: "null", Type: reflect.TypeFor[[]string](), Field: "ids"}
	}
	return json.Unmarshal(raw.IDs, &p.IDs)
}

// visibleToUserSQL: announcements have no recipient and reach everyone;
// personal notices, such as a tech's new session, carry a kind and data for
// the client to render.
const visibleToUserSQL = `(n."recipientId" IS NULL OR n."recipientId" = $1)`

type NotificationWithReadRow struct {
	ID                string          `db:"id"`
	Title             string          `db:"title"`
	Content           string          `db:"content"`
	Severity          string          `db:"severity"`
	Kind              *string         `db:"kind"`
	Data              json.RawMessage `db:"data"`
	CreatedBy         string          `db:"created_by"`
	CreatedAt         time.Time       `db:"created_at"`
	CreatedByUsername string          `db:"created_by_username"`
	ReadAt            *time.Time      `db:"read_at"`
}

// notify records a personal notice in the caller's transaction. data is
// any JSON value.
func notify(ctx context.Context, tx DBTX, recipientID, actorID, kind, title, content string, data any) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return dbError(err, "Failed to create notification")
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "Notification" (id, title, content, severity, "createdBy", "recipientId", kind, data)
        VALUES ($1, $2, $3, 'normal', $4, $5, $6, $7)`,
		uuid.NewString(), title, content, actorID, recipientID, kind, string(encoded)); err != nil {
		return dbError(err, "Failed to create notification")
	}
	return nil
}

func (a *App) createNotification(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authUser, err := a.adminUser(r)
	if err != nil {
		return err
	}
	var payload CreateNotificationPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()

	title, content, severity := "", "", "normal"
	if payload.Title != nil {
		title = strings.TrimSpace(*payload.Title)
	}
	if payload.Content != nil {
		content = strings.TrimSpace(*payload.Content)
	}
	if payload.Severity != nil {
		severity = *payload.Severity
	}
	severity = strings.ToLower(severity)

	if title == "" || content == "" {
		return badRequest("Title and content are required")
	}

	if severity != "normal" && severity != "emergency" {
		return badRequest("Invalid notification severity")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	row, err := queryOne[NotificationWithReadRow](ctx, tx, `
        INSERT INTO "Notification" (id, title, content, severity, "createdBy")
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
            id,
            title,
            content,
            severity,
            kind,
            data,
            "createdBy" as created_by,
            "createdAt" as created_at,
            (SELECT username FROM "User" WHERE id = "createdBy") as created_by_username,
            NULL::TIMESTAMPTZ as read_at
        `, uuid.NewString(), title, content, severity, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to create notification")
	}

	if err := recordDetails(ctx, tx, client, "notification.created", &authUser.ID, &authUser.Username, &row.ID, true, nil, nil,
		map[string]any{"severity": severity}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	slog.Info("notification created", "actor_id", authUser.ID, "actor_role", authUser.Role,
		"notification_id", row.ID, "severity", row.Severity, "title", row.Title)

	writeJSON(w, http.StatusCreated, map[string]any{"notification": notificationToJSON(&row)})
	return nil
}

func (a *App) listNotifications(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	notifications, err := queryAll[NotificationWithReadRow](r.Context(), a.DB, `
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n.kind,
            n.data,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            nr."readAt" as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE `+visibleToUserSQL+`
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        `, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load notifications")
	}

	writeJSON(w, http.StatusOK, map[string]any{"notifications": notificationsToJSON(notifications)})
	return nil
}

func (a *App) listUnreadNotifications(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	notifications, err := queryAll[NotificationWithReadRow](r.Context(), a.DB, `
        SELECT
            n.id,
            n.title,
            n.content,
            n.severity,
            n.kind,
            n.data,
            n."createdBy" as created_by,
            n."createdAt" as created_at,
            u.username as created_by_username,
            NULL::TIMESTAMPTZ as read_at
        FROM "Notification" n
        JOIN "User" u ON u.id = n."createdBy"
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL AND `+visibleToUserSQL+`
        ORDER BY
            CASE WHEN n.severity = 'emergency' THEN 0 ELSE 1 END,
            n."createdAt" DESC
        `, authUser.ID)
	if err != nil {
		return dbError(err, "Failed to load unread notifications")
	}

	writeJSON(w, http.StatusOK, map[string]any{"notifications": notificationsToJSON(notifications)})
	return nil
}

func (a *App) markAllNotificationsRead(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	return a.markRead(w, r, authUser, nil)
}

// markNotificationsRead marks the given notices read, such as one the user
// acknowledged in a toast.
func (a *App) markNotificationsRead(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	var payload MarkNotificationsReadPayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if len(payload.IDs) == 0 || len(payload.IDs) > 100 {
		return badRequest("Between 1 and 100 notification IDs are required")
	}
	return a.markRead(w, r, authUser, payload.IDs)
}

// markRead marks the user's unread notices read: all of them when only is
// nil, else those of only.
func (a *App) markRead(w http.ResponseWriter, r *http.Request, authUser *AuthUser, only []string) error {
	ctx := r.Context()
	var onlyParam any
	if only != nil {
		onlyParam = only
	}
	unreadIDs, err := scalars[string](ctx, a.DB, `
        SELECT n.id
        FROM "Notification" n
        LEFT JOIN "NotificationRead" nr
          ON nr."notificationId" = n.id
         AND nr."userId" = $1
        WHERE nr.id IS NULL AND `+visibleToUserSQL+`
          AND ($2::text[] IS NULL OR n.id = ANY($2))
        `, authUser.ID, onlyParam)
	if err != nil {
		return dbError(err, "Failed to load unread notifications")
	}

	if len(unreadIDs) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{"markedCount": 0})
		return nil
	}

	// One statement for every notice, as sqlx's QueryBuilder::push_values
	// writes it.
	var builder strings.Builder
	builder.WriteString(`INSERT INTO "NotificationRead" (id, "notificationId", "userId", "readAt") VALUES `)
	args := make([]any, 0, len(unreadIDs)*4)
	for i, notificationID := range unreadIDs {
		if i > 0 {
			builder.WriteString(", ")
		}
		n := i * 4
		fmt.Fprintf(&builder, "($%d, $%d, $%d, $%d)", n+1, n+2, n+3, n+4)
		args = append(args, uuid.NewString(), notificationID, authUser.ID, time.Now().UTC())
	}
	builder.WriteString(` ON CONFLICT ("notificationId", "userId") DO NOTHING`)

	tag, err := a.DB.Exec(ctx, builder.String(), args...)
	if err != nil {
		return dbError(err, "Failed to mark notifications as read")
	}

	markedCount := tag.RowsAffected()
	slog.Info("notifications marked as read", "actor_id", authUser.ID, "username", authUser.Username, "marked_count", markedCount)

	writeJSON(w, http.StatusOK, map[string]any{"markedCount": markedCount})
	return nil
}

// notificationsToJSON is notifications.iter().map(notification_to_json).
func notificationsToJSON(rows []NotificationWithReadRow) []map[string]any {
	out := make([]map[string]any, 0, len(rows))
	for i := range rows {
		out = append(out, notificationToJSON(&rows[i]))
	}
	return out
}

func notificationToJSON(row *NotificationWithReadRow) map[string]any {
	// A NULL data column and a stored JSON null both answer null.
	var data any
	if len(row.Data) != 0 {
		data = row.Data
	}
	return map[string]any{
		"id":        row.ID,
		"title":     row.Title,
		"content":   row.Content,
		"severity":  row.Severity,
		"kind":      row.Kind,
		"data":      data,
		"createdAt": isoString(row.CreatedAt),
		"isRead":    row.ReadAt != nil,
		"readAt":    isoStringOpt(row.ReadAt),
		"createdBy": map[string]any{
			"id":       row.CreatedBy,
			"username": row.CreatedByUsername,
		},
	}
}
