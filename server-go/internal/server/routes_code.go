package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"
)

const cacheTTL = 60 * time.Second

// languageMap (LANGUAGE_MAP): editor language → Piston language, in order.
var languageMap = [][2]string{
	{"c", "c"},
	{"cpp", "c++"},
	{"csharp", "csharp"},
	{"go", "go"},
	{"java", "java"},
	{"javascript", "javascript"},
	{"typescript", "typescript"},
	{"python", "python"},
	{"rust", "rust"},
	{"ruby", "ruby"},
	{"php", "php"},
	{"swift", "swift"},
	{"kotlin", "kotlin"},
	{"scala", "scala"},
	{"r", "rscript"},
	{"perl", "perl"},
	{"lua", "lua"},
	{"haskell", "haskell"},
	{"bash", "bash"},
	{"sql", "sqlite3"},
	{"plaintext", "bash"},
}

// fileExtensions (FILE_EXTENSIONS): Piston language → source file extension.
var fileExtensions = [][2]string{
	{"c", "c"},
	{"c++", "cpp"},
	{"csharp", "cs"},
	{"go", "go"},
	{"java", "java"},
	{"javascript", "js"},
	{"node", "js"},
	{"typescript", "ts"},
	{"python", "py"},
	{"rust", "rs"},
	{"ruby", "rb"},
	{"php", "php"},
	{"swift", "swift"},
	{"kotlin", "kt"},
	{"scala", "scala"},
	{"rscript", "r"},
	{"perl", "pl"},
	{"lua", "lua"},
	{"haskell", "hs"},
	{"bash", "sh"},
	{"sqlite3", "sql"},
}

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("POST /api/code/execute", h(a.executeCode))
		mux.HandleFunc("GET /api/code/languages", h(a.getLanguages))
		mux.HandleFunc("GET /api/code/health", h(a.checkPistonHealth))
	})
}

// ExecuteRequest keeps the snake_case field names of the Rust struct.
type ExecuteRequest struct {
	SourceCode *string `json:"source_code"`
	LanguageID *string `json:"language_id"`
	Stdin      *string `json:"stdin"`
}

type PistonExecuteRequest struct {
	Language       string       `json:"language"`
	Version        string       `json:"version"`
	Files          []PistonFile `json:"files"`
	Stdin          *string      `json:"stdin,omitempty"`
	RunTimeout     uint32       `json:"run_timeout"`
	CompileTimeout uint32       `json:"compile_timeout"`
}

type PistonFile struct {
	Name    *string `json:"name,omitempty"`
	Content string  `json:"content"`
}

type PistonRuntime struct {
	Language string
	Version  string
	Aliases  []string
}

// UnmarshalJSON requires every field, as serde does for fields without
// Option.
func (p *PistonRuntime) UnmarshalJSON(data []byte) error {
	var raw struct {
		Language *string   `json:"language"`
		Version  *string   `json:"version"`
		Aliases  *[]string `json:"aliases"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	switch {
	case raw.Language == nil:
		return errors.New("missing field `language`")
	case raw.Version == nil:
		return errors.New("missing field `version`")
	case raw.Aliases == nil:
		return errors.New("missing field `aliases`")
	}
	*p = PistonRuntime{Language: *raw.Language, Version: *raw.Version, Aliases: *raw.Aliases}
	return nil
}

type PistonResult struct {
	Compile *PistonRunResult `json:"compile"`
	Run     *PistonRunResult `json:"run"`
}

type PistonRunResult struct {
	Stdout   string
	Stderr   string
	Code     *int32
	Signal   *string
	Message  *string
	Status   *string
	Memory   *int64
	WallTime *float64
}

// UnmarshalJSON requires stdout and stderr, as serde does.
func (p *PistonRunResult) UnmarshalJSON(data []byte) error {
	var raw struct {
		Stdout   *string  `json:"stdout"`
		Stderr   *string  `json:"stderr"`
		Code     *int32   `json:"code"`
		Signal   *string  `json:"signal"`
		Message  *string  `json:"message"`
		Status   *string  `json:"status"`
		Memory   *int64   `json:"memory"`
		WallTime *float64 `json:"wall_time"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	switch {
	case raw.Stdout == nil:
		return errors.New("missing field `stdout`")
	case raw.Stderr == nil:
		return errors.New("missing field `stderr`")
	}
	*p = PistonRunResult{
		Stdout: *raw.Stdout, Stderr: *raw.Stderr, Code: raw.Code, Signal: raw.Signal,
		Message: raw.Message, Status: raw.Status, Memory: raw.Memory, WallTime: raw.WallTime,
	}
	return nil
}

type RuntimeCache struct {
	runtimes  []PistonRuntime
	fetchedAt time.Time
}

var (
	runtimeCacheLock sync.RWMutex
	runtimeCache     *RuntimeCache
)

// pistonRequest sends one request with a timeout over the whole exchange,
// body included, as reqwest's per-request timeout. The returned
// cancel must be called once the body has been read.
func pistonRequest(ctx context.Context, method, url string, body []byte, timeout time.Duration) (*http.Response, context.CancelFunc, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return response, cancel, nil
}

func isSuccessStatus(status int) bool { return status >= 200 && status < 300 }

func executionFailed(message string) map[string]any {
	return map[string]any{
		"error":     "Code execution failed",
		"message":   message,
		"output":    "",
		"status":    "Internal Error",
		"statusId":  13,
		"isSuccess": false,
	}
}

func (a *App) executeCode(w http.ResponseWriter, r *http.Request) error {
	actor, err := a.authActor(r)
	if err != nil {
		return err
	}
	var payload ExecuteRequest
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	ctx := r.Context()
	// Accounts run code anywhere; a share guest only in their room, and only while they can write to it.
	if guest := actor.Guest; guest != nil {
		canWrite, err := requireContentAccess(ctx, a.DB, actor, guest.RoomID)
		if err != nil {
			return err
		}
		if !canWrite {
			return forbidden("Only people who can edit this room can run code")
		}
	}
	var sourceCode, languageID string
	if payload.SourceCode != nil {
		sourceCode = *payload.SourceCode
	}
	if payload.LanguageID != nil {
		languageID = *payload.LanguageID
	}

	if sourceCode == "" {
		return badRequest("Source code is required")
	}

	if languageID == "" {
		return badRequest("Language ID is required")
	}

	pistonLanguage := mapLanguage(languageID)
	runtimes, err := a.getRuntimes(ctx)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, executionFailed(err.Error()))
		return nil
	}
	runtime := findRuntime(runtimes, pistonLanguage)
	if runtime == nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":     fmt.Sprintf("Language '%s' is not supported", languageID),
			"output":    "",
			"status":    "Language Not Found",
			"statusId":  0,
			"isSuccess": false,
		})
		return nil
	}

	// Let the Java runtime choose its source-launcher filename. Other
	// runtimes use the editor language extension (not package aliases).
	var fileName *string
	if pistonLanguage != "java" {
		fileName = ptr("main." + fileExtension(pistonLanguage))
	}

	var stdin string
	if payload.Stdin != nil {
		stdin = *payload.Stdin
	}
	pistonRequestBody, err := json.Marshal(PistonExecuteRequest{
		Language:       runtime.Language,
		Version:        runtime.Version,
		Files:          []PistonFile{{Name: fileName, Content: sourceCode}},
		Stdin:          &stdin,
		RunTimeout:     3000,
		CompileTimeout: 10000,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, executionFailed(err.Error()))
		return nil
	}

	response, cancel, err := pistonRequest(ctx, http.MethodPost, a.Config.PistonURL+"/api/v2/execute", pistonRequestBody, 20*time.Second)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, executionFailed(err.Error()))
		return nil
	}
	defer cancel()
	defer response.Body.Close()

	if !isSuccessStatus(response.StatusCode) {
		// unwrap_or_default: a body that cannot be read is an empty message.
		text, err := io.ReadAll(response.Body)
		if err != nil {
			text = nil
		}
		writeJSON(w, http.StatusInternalServerError, executionFailed(string(text)))
		return nil
	}

	var result PistonResult
	if err := decodePistonBody(response.Body, &result); err != nil {
		return internalError(fmt.Sprintf("Failed to parse piston response: %s", err))
	}

	writeJSON(w, http.StatusOK, executionResult(result))
	return nil
}

func decodePistonBody(body io.Reader, v any) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func executionResult(result PistonResult) map[string]any {
	compileFailed := result.Compile != nil && !result.Compile.succeeded()
	stage := result.Run
	if compileFailed {
		stage = result.Compile
	}
	if stage == nil {
		return map[string]any{"output": "", "error": "Code execution returned no result", "status": "Internal Error", "statusId": 13, "isSuccess": false}
	}
	timedOut := stage.Status != nil && *stage.Status == "TO"
	isSuccess := !compileFailed && stage.succeeded()
	var status string
	var statusID int
	switch {
	case timedOut:
		status, statusID = "Time Limit Exceeded", 5
	case compileFailed:
		status, statusID = "Compilation Error", 6
	case isSuccess:
		status, statusID = "Accepted", 3
	default:
		status, statusID = "Runtime Error", 11
	}
	var errorText string
	switch {
	case stage.Stderr != "":
		errorText = stage.Stderr
	case !isSuccess:
		switch {
		case stage.Message != nil && *stage.Message != "":
			errorText = *stage.Message
		case stage.Signal != nil:
			errorText = fmt.Sprintf("%s (%s)", status, *stage.Signal)
		default:
			errorText = status
		}
	}
	response := map[string]any{
		"output": stage.Stdout, "error": errorText, "status": status,
		"statusId": statusID, "isSuccess": isSuccess,
	}
	if stage.WallTime != nil {
		response["time"] = fmt.Sprintf("%.3f", *stage.WallTime/1000.0)
	}
	if stage.Memory != nil {
		response["memory"] = int64(math.Round(float64(*stage.Memory) / 1024.0))
	}
	return response
}

func (p *PistonRunResult) succeeded() bool {
	return p.Code != nil && *p.Code == 0 && p.Signal == nil &&
		(p.Status == nil || *p.Status == "OK")
}

func (a *App) getLanguages(w http.ResponseWriter, r *http.Request) error {
	runtimes, err := a.getRuntimes(r.Context())
	if err != nil {
		return internalError("Failed to get languages")
	}

	languages := []map[string]any{}
	for _, pair := range languageMap {
		editorLang, pistonLang := pair[0], pair[1]
		if runtime := findRuntime(runtimes, pistonLang); runtime != nil {
			languages = append(languages, map[string]any{
				"name":      editorLang,
				"id":        editorLang,
				"version":   runtime.Version,
				"available": true,
			})
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"languages": languages})
	return nil
}

func (a *App) checkPistonHealth(w http.ResponseWriter, r *http.Request) error {
	unavailable := map[string]any{
		"status": "error",
		"error":  "Piston is not available",
	}
	response, cancel, err := pistonRequest(r.Context(), http.MethodGet, a.Config.PistonURL+"/api/v2/runtimes", nil, 5*time.Second)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, unavailable)
		return nil
	}
	defer cancel()
	defer response.Body.Close()

	if !isSuccessStatus(response.StatusCode) {
		writeJSON(w, http.StatusServiceUnavailable, unavailable)
		return nil
	}

	var runtimes []PistonRuntime
	if err := decodeRuntimes(response.Body, &runtimes); err != nil {
		return internalError(fmt.Sprintf("Failed to parse runtimes: %s", err))
	}

	missing := []string{}
	for _, language := range []string{"python", "java", "c", "c++", "javascript", "typescript"} {
		if findRuntime(runtimes, language) == nil {
			missing = append(missing, language)
		}
	}
	ready := len(missing) == 0
	status, state := http.StatusOK, "ok"
	if !ready {
		status, state = http.StatusServiceUnavailable, "error"
	}
	languages := make([]string, 0, len(runtimes))
	for _, runtime := range runtimes {
		languages = append(languages, runtime.Language)
	}
	writeJSON(w, status, map[string]any{
		"status":           state,
		"missingLanguages": missing,
		"piston": map[string]any{
			"runtimes":  len(runtimes),
			"languages": languages,
		},
	})
	return nil
}

// decodeRuntimes reads a runtime list; serde does not take null for a Vec.
func decodeRuntimes(body io.Reader, runtimes *[]PistonRuntime) error {
	if err := decodePistonBody(body, runtimes); err != nil {
		return err
	}
	if *runtimes == nil {
		return errors.New("invalid type: null, expected a sequence")
	}
	return nil
}

func (a *App) getRuntimes(ctx context.Context) ([]PistonRuntime, error) {
	runtimeCacheLock.RLock()
	if cache := runtimeCache; cache != nil && time.Since(cache.fetchedAt) < cacheTTL {
		runtimeCacheLock.RUnlock()
		return cache.runtimes, nil
	}
	runtimeCacheLock.RUnlock()

	response, cancel, err := pistonRequest(ctx, http.MethodGet, a.Config.PistonURL+"/api/v2/runtimes", nil, 5*time.Second)
	if err != nil {
		return nil, internalError(fmt.Sprintf("Piston API error: %s", err))
	}
	defer cancel()
	defer response.Body.Close()

	if !isSuccessStatus(response.StatusCode) {
		text, err := io.ReadAll(response.Body)
		if err != nil {
			text = nil
		}
		return nil, internalError(fmt.Sprintf("Piston API error: %s - %s", statusDisplay(response.StatusCode), text))
	}

	var runtimes []PistonRuntime
	if err := decodeRuntimes(response.Body, &runtimes); err != nil {
		return nil, internalError(fmt.Sprintf("Failed to parse runtimes: %s", err))
	}

	runtimeCacheLock.Lock()
	runtimeCache = &RuntimeCache{runtimes: runtimes, fetchedAt: time.Now()}
	runtimeCacheLock.Unlock()

	return runtimes, nil
}

// statusDisplay writes a status as http::StatusCode displays it: the code
// and its canonical reason ("500 Internal Server Error").
func statusDisplay(status int) string {
	reason := http.StatusText(status)
	if reason == "" {
		reason = "<unknown status code>"
	}
	return fmt.Sprintf("%d %s", status, reason)
}

func findRuntime(runtimes []PistonRuntime, language string) *PistonRuntime {
	for i := range runtimes {
		if runtimes[i].Language == language || slices.Contains(runtimes[i].Aliases, language) {
			return &runtimes[i]
		}
	}
	return nil
}

func mapLanguage(language string) string {
	for _, pair := range languageMap {
		if pair[0] == language {
			return pair[1]
		}
	}
	return language
}

func fileExtension(language string) string {
	for _, pair := range fileExtensions {
		if pair[0] == language {
			return pair[1]
		}
	}
	return "txt"
}
