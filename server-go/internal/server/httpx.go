package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"time"
)

// ApiError is an error with the HTTP status it is answered with. The body
// is {"error": message}, as server-rs writes it.
type ApiError struct {
	Status  int
	Message string
}

func (e *ApiError) Error() string { return e.Message }

func badRequest(message string) *ApiError   { return &ApiError{http.StatusBadRequest, message} }
func unauthorized(message string) *ApiError { return &ApiError{http.StatusUnauthorized, message} }
func forbidden(message string) *ApiError    { return &ApiError{http.StatusForbidden, message} }
func notFound(message string) *ApiError     { return &ApiError{http.StatusNotFound, message} }
func conflict(message string) *ApiError     { return &ApiError{http.StatusConflict, message} }
func gone(message string) *ApiError         { return &ApiError{http.StatusGone, message} }
func serviceUnavailable(message string) *ApiError {
	return &ApiError{http.StatusServiceUnavailable, message}
}
func internalError(message string) *ApiError {
	return &ApiError{http.StatusInternalServerError, message}
}

// plainError is an error answered as plain text with a status, the way
// axum's own extractors answer (a body that is not JSON, a path that does
// not parse).
type plainError struct {
	Status  int
	Message string
}

func (e *plainError) Error() string { return e.Message }

// writeJSON writes v as a JSON response.
func writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		slog.Error("failed to encode response", "error", err)
		http.Error(w, `{"error":"Internal server error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// writeError answers with err: an *ApiError as its JSON, a *plainError as
// text, anything else as a logged 500.
func writeError(w http.ResponseWriter, err error) {
	var api *ApiError
	var plain *plainError
	switch {
	case errors.As(err, &api):
		writeJSON(w, api.Status, map[string]string{"error": api.Message})
	case errors.As(err, &plain):
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(plain.Status)
		_, _ = io.WriteString(w, plain.Message)
	default:
		slog.Error("unhandled error", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "Internal server error"})
	}
}

// handler is what the routes implement: it writes its own success response
// and returns an error for everything else.
type handler func(w http.ResponseWriter, r *http.Request) error

// h adapts a handler to net/http.
func h(fn handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			writeError(w, err)
		}
	}
}

// maxJSONBody is axum's default body limit.
const maxJSONBody = 2 << 20

// readJSON decodes a JSON request body into v, answering as axum's Json
// extractor does when it cannot: 415 without a JSON content type, 400 for
// what is not JSON, 422 for JSON of the wrong shape, 413 for too much.
// Unknown fields are ignored, as serde ignores them.
func readJSON(w http.ResponseWriter, r *http.Request, v any) error {
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType != "application/json" && !strings.HasSuffix(mediaType, "+json") {
		return &plainError{http.StatusUnsupportedMediaType, "Expected request with `Content-Type: application/json`"}
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &plainError{http.StatusRequestEntityTooLarge, "Failed to buffer the request body: length limit exceeded"}
		}
		return &plainError{http.StatusBadRequest, "Failed to buffer the request body"}
	}
	if err := json.Unmarshal(body, v); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) || errors.Is(err, io.ErrUnexpectedEOF) || len(body) == 0 {
			return &plainError{http.StatusBadRequest, "Failed to parse the request body as JSON: " + err.Error()}
		}
		return &plainError{http.StatusUnprocessableEntity, "Failed to deserialize the JSON body into the target type: " + err.Error()}
	}
	return nil
}

// requireFields answers 422, as serde does for a missing field, when one of
// the named values is nil. Pass pointers to the fields that Rust declares
// without Option: name, pointer, name, pointer…
func requireFields(pairs ...any) error {
	for i := 0; i+1 < len(pairs); i += 2 {
		if isNilPointer(pairs[i+1]) {
			return &plainError{http.StatusUnprocessableEntity,
				fmt.Sprintf("Failed to deserialize the JSON body into the target type: missing field `%s`", pairs[i])}
		}
	}
	return nil
}

func isNilPointer(v any) bool {
	switch p := v.(type) {
	case nil:
		return true
	case *string:
		return p == nil
	case *bool:
		return p == nil
	case *int:
		return p == nil
	case *int32:
		return p == nil
	case *int64:
		return p == nil
	case *float64:
		return p == nil
	}
	return false
}

// autoSi formats t in UTC as chrono's SecondsFormat::AutoSi does: no
// fraction when it is zero, else three, six or nine digits.
func autoSi(t time.Time) string {
	t = t.UTC()
	base := t.Format("2006-01-02T15:04:05")
	switch ns := t.Nanosecond(); {
	case ns == 0:
		return base
	case ns%1_000_000 == 0:
		return fmt.Sprintf("%s.%03d", base, ns/1_000_000)
	case ns%1_000 == 0:
		return fmt.Sprintf("%s.%06d", base, ns/1_000)
	default:
		return fmt.Sprintf("%s.%09d", base, ns)
	}
}

// isoString is server-rs's to_iso_string (chrono to_rfc3339): the offset is
// written "+00:00".
func isoString(t time.Time) string { return autoSi(t) + "+00:00" }

// isoStringOpt is to_iso_string_opt.
func isoStringOpt(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := isoString(*t)
	return &s
}

// Time is a timestamp that encodes to JSON as chrono's serde does for a
// DateTime<Utc> field: the offset is written "Z". Use it for fields Rust
// serializes directly, and isoString where Rust calls to_iso_string.
type Time struct{ time.Time }

func (t Time) MarshalJSON() ([]byte, error) { return json.Marshal(autoSi(t.Time) + "Z") }

// Scan reads a timestamp column.
func (t *Time) Scan(src any) error {
	switch v := src.(type) {
	case time.Time:
		t.Time = v
		return nil
	case nil:
		return errors.New("cannot scan NULL into Time; use *Time")
	}
	return fmt.Errorf("cannot scan %T into Time", src)
}

func (t *Time) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return err
	}
	t.Time = parsed
	return nil
}

// ptr returns a pointer to v.
func ptr[T any](v T) *T { return &v }

// --- middleware ---

// statusWriter remembers the status a handler answered with.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the connection (WebSocket
// upgrades, flushing).
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// logRequests logs one line per request, as the trace layer of server-rs.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		pattern := r.Pattern
		if pattern == "" {
			pattern = "unmatched"
		}
		slog.Info("request", "method", r.Method, "path", pattern, "status", sw.status, "latency_ms", time.Since(start).Milliseconds())
	})
}

// cors answers as the CORS layer of server-rs: an allowed origin is echoed
// with credentials, and a preflight mirrors the methods and headers it asks
// for.
func (a *App) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		header := w.Header()
		header.Add("Vary", "Origin")
		allowed := origin != "" && allowedOrigin(a.Config, origin)
		if allowed {
			header.Set("Access-Control-Allow-Origin", origin)
			header.Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			header.Add("Vary", "Access-Control-Request-Method")
			header.Add("Vary", "Access-Control-Request-Headers")
			if allowed {
				header.Set("Access-Control-Allow-Methods", r.Header.Get("Access-Control-Request-Method"))
				if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
					header.Set("Access-Control-Allow-Headers", requested)
				}
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
