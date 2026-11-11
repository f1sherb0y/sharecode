package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The Rust module has no tests; these cover what the port had to write by
// hand: the route table (net/http refuses patterns axum accepts) and
// chrono's parsing of scheduled times.

func TestRoomRoutesRegister(t *testing.T) {
	a := &App{}
	mux := http.NewServeMux()
	registerRoomRoutes(a, mux)
	registerPlaybackRoutes(a, mux)
	registerNoteRoutes(a, mux)
	// The share module's routes, which must fit beside these.
	for _, pattern := range []string{
		"POST /api/rooms/{roomId}/share-links",
		"GET /api/rooms/{roomId}/share-links",
		"DELETE /api/rooms/{roomId}/share-links/{shareLinkId}",
	} {
		mux.HandleFunc(pattern, func(http.ResponseWriter, *http.Request) {})
	}

	cases := []struct{ method, path, pattern string }{
		{"GET", "/api/rooms/by-document/abc", "GET /api/rooms/{roomId}/{documentId}"},
		{"GET", "/api/rooms/abc", "GET /api/rooms/{roomId}"},
		{"GET", "/api/rooms/abc/notes", "GET /api/rooms/{roomId}/notes"},
		{"GET", "/api/rooms/abc/share-links", "GET /api/rooms/{roomId}/share-links"},
		{"GET", "/api/rooms/abc/playback/updates", "GET /api/rooms/{roomId}/playback/updates"},
		{"PUT", "/api/rooms/abc/pin", "PUT /api/rooms/{roomId}/pin"},
		{"POST", "/api/rooms/abc/end", "POST /api/rooms/{roomId}/end"},
		{"PUT", "/api/rooms/abc/notes/n1", "PUT /api/rooms/{roomId}/notes/{noteId}"},
	}
	for _, c := range cases {
		_, pattern := mux.Handler(httptest.NewRequest(c.method, c.path, nil))
		if pattern != c.pattern {
			t.Errorf("%s %s: routed to %q, want %q", c.method, c.path, pattern, c.pattern)
		}
	}

	for path, status := range map[string]int{
		"/api/rooms/abc/pin":   http.StatusMethodNotAllowed,
		"/api/rooms/abc/end":   http.StatusMethodNotAllowed,
		"/api/rooms/abc/other": http.StatusNotFound,
	} {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		if recorder.Code != status {
			t.Errorf("GET %s: status %d, want %d", path, recorder.Code, status)
		}
	}
}

func TestParseScheduledTime(t *testing.T) {
	shanghai, newYork := "Asia/Shanghai", "America/New_York"
	unknown := "Not/AZone"
	cases := []struct {
		value    string
		timezone *string
		want     string // "" = error
	}{
		{"2026-03-01T10:00:00Z", nil, "2026-03-01T10:00:00Z"},
		{"2026-03-01T10:00:00+08:00", &newYork, "2026-03-01T02:00:00Z"},
		{"2026-03-01 10:00:00.5+08:00", nil, "2026-03-01T02:00:00.5Z"},
		{"2026-03-01t10:00:00z", nil, "2026-03-01T10:00:00Z"},
		{"2026-03-01T10:00:00+0800", nil, "2026-03-01T02:00:00Z"},
		{"2026-3-1T9:05:00 +08:00", nil, "2026-03-01T01:05:00Z"},
		{"2026-03-01T10:00", &shanghai, "2026-03-01T02:00:00Z"},
		{"2026-03-01T10:00:30", &shanghai, "2026-03-01T02:00:30Z"},
		{"2026-03-01 10:00", &shanghai, "2026-03-01T02:00:00Z"},
		{"2026-03-01 10:00:30", nil, "2026-03-01T10:00:30Z"},
		{"2026-03-01T10:00", &unknown, "2026-03-01T10:00:00Z"},
		{"2026-03-01T10:00", ptr(""), "2026-03-01T10:00:00Z"},
		{"2026-03-01T10:00", ptr("Local"), "2026-03-01T10:00:00Z"},
		{"2026-07-01T10:00", &newYork, "2026-07-01T14:00:00Z"},
		// A local time that does not exist, and one that exists twice, are read as UTC.
		{"2026-03-08T02:30", &newYork, "2026-03-08T02:30:00Z"},
		{"2026-11-01T01:30", &newYork, "2026-11-01T01:30:00Z"},
		{"2026-11-01T00:30", &newYork, "2026-11-01T04:30:00Z"},
		{"2026-11-01T02:30", &newYork, "2026-11-01T07:30:00Z"},
		{"2026-03-01T10:00:00.000", nil, ""},
		{"2026-02-30T10:00", nil, ""},
		{"2026-03-01T24:00", nil, ""},
		{"2026-03-01", nil, ""},
		{"2026-03-01T10:00 ", nil, ""},
		{"tomorrow", nil, ""},
	}
	for _, c := range cases {
		got, err := parseScheduledTime(c.value, c.timezone)
		if c.want == "" {
			if err == nil {
				t.Errorf("%q: parsed as %s, want an error", c.value, got)
			} else if api, ok := err.(*ApiError); !ok || api.Status != 500 || api.Message != "Internal server error" {
				t.Errorf("%q: error %v", c.value, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q: %v", c.value, err)
			continue
		}
		if text := got.Format(time.RFC3339Nano); text != c.want {
			t.Errorf("%q: got %s, want %s", c.value, text, c.want)
		}
	}
}

func TestParseGetRoomsQuery(t *testing.T) {
	query, err := parseGetRoomsQuery(httptest.NewRequest("GET", "/api/rooms?page=2&pageSize=%2B5&ownerId=+u1+&activeness=ended", nil))
	if err != nil {
		t.Fatal(err)
	}
	if *query.Page != 2 || *query.PageSize != 5 || *query.OwnerID != " u1 " || *query.Activeness != RoomActivenessFilterEnded {
		t.Errorf("unexpected query %+v", query)
	}
	if query, err := parseGetRoomsQuery(httptest.NewRequest("GET", "/api/rooms", nil)); err != nil ||
		query.Page != nil || query.PageSize != nil || query.OwnerID != nil || query.Activeness != nil {
		t.Errorf("empty query: %+v, %v", query, err)
	}
	for _, raw := range []string{"page=", "page=-1", "page=x", "pageSize=4294967296", "activeness=Active", "activeness=", "page=1&page=2"} {
		_, err := parseGetRoomsQuery(httptest.NewRequest("GET", "/api/rooms?"+raw, nil))
		if plain, ok := err.(*plainError); !ok || plain.Status != http.StatusBadRequest {
			t.Errorf("%q: error %v, want a 400", raw, err)
		}
	}
}

func TestPlaybackSecondsJSON(t *testing.T) {
	for value, want := range map[float64]string{0: "0.0", 12: "12.0", 1.5: "1.5", 0.001: "0.001", 3600.25: "3600.25"} {
		got, err := json.Marshal(playbackSeconds(value))
		if err != nil || string(got) != want {
			t.Errorf("%v: got %s (%v), want %s", value, got, err, want)
		}
	}
}

// Every module's routes together: a conflict between patterns panics here.
func TestAllRoutesRegister(t *testing.T) {
	a := &App{Config: &Config{}}
	a.WS = newWsState(a)
	_ = a.Handler()
}
