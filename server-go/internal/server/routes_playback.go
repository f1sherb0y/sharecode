package server

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"net/http"
	"strconv"
	"strings"
)

func init() {
	registrars = append(registrars, registerPlaybackRoutes)
}

func registerPlaybackRoutes(a *App, mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms/{roomId}/playback/updates", h(a.getPlaybackUpdates))
}

// playbackSeconds is an f64 as serde_json writes it: a whole number keeps
// its ".0".
type playbackSeconds float64

func (s playbackSeconds) MarshalJSON() ([]byte, error) {
	text := strconv.FormatFloat(float64(s), 'f', -1, 64)
	if !strings.Contains(text, ".") {
		text += ".0"
	}
	return []byte(text), nil
}

// getPlaybackUpdates is GET /api/rooms/{roomId}/playback/updates.
func (a *App) getPlaybackUpdates(w http.ResponseWriter, r *http.Request) error {
	authUser, err := a.authUser(r)
	if err != nil {
		return err
	}
	roomID := r.PathValue("roomId")
	ctx := r.Context()
	room, err := requireRoomAccess(ctx, a.DB, authUser, roomID)
	if err != nil {
		return err
	}
	if !room.CanViewPlayback {
		return notFound("Room not found")
	}
	if !room.IsEnded {
		return badRequest("Room has not ended yet")
	}

	if err := a.WS.WaitForSaved(ctx, roomID); err != nil {
		return err
	}
	updates, err := queryAll[DocumentUpdateRow](ctx, a.DB, `
        SELECT
            id,
            "documentId" as document_id,
            update,
            timestamp,
            "userId" as user_id
        FROM "DocumentUpdate"
        WHERE "documentId" = $1
        ORDER BY timestamp ASC, seq ASC
        `, roomID)
	if err != nil {
		return dbError(err, "Failed to load playback updates")
	}

	if len(updates) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"updates":   []any{},
			"startTime": nil,
			"endTime":   nil,
			"duration":  0,
		})
		return nil
	}

	startTime := updates[0].Timestamp
	endTime := updates[len(updates)-1].Timestamp
	duration := playbackSeconds(float64(endTime.Sub(startTime).Milliseconds()) / 1000.0)

	compressedUpdates := make([]map[string]any, 0, len(updates))
	for _, update := range updates {
		compressed, err := gzipBytes(update.Update)
		if err != nil {
			return internalError("Failed to compress update: " + err.Error())
		}
		encoded := base64.StdEncoding.EncodeToString(compressed)
		compressedUpdates = append(compressedUpdates, map[string]any{
			"id":        update.ID,
			"timestamp": isoString(update.Timestamp),
			"update":    encoded,
			"userId":    update.UserID,
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"updates":   compressedUpdates,
		"startTime": isoString(startTime),
		"endTime":   isoString(endTime),
		"duration":  duration,
	})
	return nil
}

func gzipBytes(input []byte) ([]byte, error) {
	var out bytes.Buffer
	encoder := gzip.NewWriter(&out)
	if _, err := encoder.Write(input); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
