package server

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

func init() {
	registrars = append(registrars, registerNoteRoutes)
}

func registerNoteRoutes(a *App, mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms/{roomId}/notes", h(a.listNotes))
	mux.HandleFunc("POST /api/rooms/{roomId}/notes", h(a.createNote))
	mux.HandleFunc("PUT /api/rooms/{roomId}/notes/{noteId}", h(a.updateNote))
	mux.HandleFunc("DELETE /api/rooms/{roomId}/notes/{noteId}", h(a.deleteNote))
}

type CreateNotePayload struct {
	Text *string `json:"text"`
}

type UpdateNotePayload struct {
	Text *string `json:"text"`
}

// listNotes is GET /api/rooms/{roomId}/notes.
func (a *App) listNotes(w http.ResponseWriter, r *http.Request) error {
	authActor, err := a.authActor(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	ctx := r.Context()

	a.WS.access.RLock()
	defer a.WS.access.RUnlock()
	if _, err := requireContentAccess(ctx, a.DB, authActor, roomID); err != nil {
		return err
	}

	notes, err := queryAll[RoomNoteRow](ctx, a.DB, `
        SELECT
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        FROM "RoomNote"
        WHERE "roomId" = $1
        ORDER BY "createdAt" ASC
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load notes")
	}

	response := make([]map[string]any, 0, len(notes))
	for i := range notes {
		response = append(response, noteToJSON(&notes[i]))
	}

	writeJSON(w, http.StatusOK, map[string]any{"notes": response})
	return nil
}

// createNote is POST /api/rooms/{roomId}/notes.
func (a *App) createNote(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authActor, err := a.authActor(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	var payload CreateNotePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := requireFields("text", payload.Text); err != nil {
		return err
	}
	ctx := r.Context()

	a.WS.access.RLock()
	defer a.WS.access.RUnlock()
	canWrite, err := requireContentAccess(ctx, a.DB, authActor, roomID)
	if err != nil {
		return err
	}

	if !canWrite {
		return notFound("Room not found")
	}

	text := strings.TrimSpace(*payload.Text)
	if text == "" {
		return badRequest("Note text is required")
	}

	noteID := uuid.NewString()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	note, err := queryOne[RoomNoteRow](ctx, tx, `
        INSERT INTO "RoomNote" (id, "roomId", text)
        VALUES ($1, $2, $3)
        RETURNING
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        `, noteID, roomID, text)
	if err != nil {
		return dbError(err, "Failed to create note")
	}

	if err := recordDetails(ctx, tx, client, "note.created", ptr(authActor.ID()), ptr(authActor.Username()), &noteID,
		true, nil, &roomID, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusCreated, map[string]any{"note": noteToJSON(&note)})
	return nil
}

// updateNote is PUT /api/rooms/{roomId}/notes/{noteId}.
func (a *App) updateNote(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authActor, err := a.authActor(r)
	if err != nil {
		return err
	}
	roomID, noteID := r.PathValue("roomId"), r.PathValue("noteId")
	var payload UpdateNotePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := requireFields("text", payload.Text); err != nil {
		return err
	}
	ctx := r.Context()

	a.WS.access.RLock()
	defer a.WS.access.RUnlock()
	canWrite, err := requireContentAccess(ctx, a.DB, authActor, roomID)
	if err != nil {
		return err
	}

	if !canWrite {
		return notFound("Room not found")
	}

	text := strings.TrimSpace(*payload.Text)
	if text == "" {
		return badRequest("Note text is required")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	note, err := queryOptional[RoomNoteRow](ctx, tx, `
        UPDATE "RoomNote"
        SET text = $3, "updatedAt" = NOW()
        WHERE id = $2 AND "roomId" = $1
        RETURNING
            id,
            "roomId" as room_id,
            text,
            "createdAt" as created_at,
            "updatedAt" as updated_at
        `, roomID, noteID, text)
	if err != nil {
		return dbError(err, "Failed to update note")
	}

	if note == nil {
		return notFound("Note not found")
	}

	if err := recordDetails(ctx, tx, client, "note.updated", ptr(authActor.ID()), ptr(authActor.Username()), &noteID,
		true, nil, &roomID, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"note": noteToJSON(note)})
	return nil
}

// deleteNote is DELETE /api/rooms/{roomId}/notes/{noteId}.
func (a *App) deleteNote(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	authActor, err := a.authActor(r)
	if err != nil {
		return err
	}
	roomID, noteID := r.PathValue("roomId"), r.PathValue("noteId")
	ctx := r.Context()

	a.WS.access.RLock()
	defer a.WS.access.RUnlock()
	canWrite, err := requireContentAccess(ctx, a.DB, authActor, roomID)
	if err != nil {
		return err
	}

	if !canWrite {
		return notFound("Room not found")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	result, err := tx.Exec(ctx, `DELETE FROM "RoomNote" WHERE id = $1 AND "roomId" = $2`, noteID, roomID)
	if err != nil {
		return dbError(err, "Failed to delete note")
	}

	if result.RowsAffected() == 0 {
		return notFound("Note not found")
	}

	if err := recordDetails(ctx, tx, client, "note.deleted", ptr(authActor.ID()), ptr(authActor.Username()), &noteID,
		true, nil, &roomID, map[string]any{}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"message": "Note deleted"})
	return nil
}

func noteToJSON(note *RoomNoteRow) map[string]any {
	return map[string]any{
		"id":        note.ID,
		"roomId":    note.RoomID,
		"text":      note.Text,
		"createdAt": isoString(note.CreatedAt),
		"updatedAt": isoString(note.UpdatedAt),
	}
}
