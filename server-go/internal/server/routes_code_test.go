package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func normalizePiston(t *testing.T, value string) map[string]any {
	t.Helper()
	var result PistonResult
	if err := json.Unmarshal([]byte(value), &result); err != nil {
		t.Fatalf("parse %s: %v", value, err)
	}
	return executionResult(result)
}

func TestAcceptsSuccessWithoutOptionalRuntimeMetrics(t *testing.T) {
	result := normalizePiston(t, `{"run":{"stdout":"42\n", "stderr":"", "code":0}}`)
	if result["isSuccess"] != true {
		t.Errorf("isSuccess = %v", result["isSuccess"])
	}
	if result["output"] != "42\n" {
		t.Errorf("output = %q", result["output"])
	}
	if _, ok := result["time"]; ok {
		t.Errorf("time present: %v", result["time"])
	}
}

func TestReportsCompileDiagnosticsWithoutRunStage(t *testing.T) {
	result := normalizePiston(t, `{"compile":{"stdout":"type error", "stderr":"", "code":1}}`)
	if result["statusId"] != 6 {
		t.Errorf("statusId = %v", result["statusId"])
	}
	if result["output"] != "type error" {
		t.Errorf("output = %q", result["output"])
	}
	if result["isSuccess"] != false {
		t.Errorf("isSuccess = %v", result["isSuccess"])
	}
}

func TestReportsTimeoutWithNullExitCodeAndSignal(t *testing.T) {
	result := normalizePiston(t, `{"run":{"stdout":"", "stderr":"", "code":null, "signal":"SIGKILL", "status":"TO", "memory":1024, "wall_time":3000}}`)
	if result["statusId"] != 5 {
		t.Errorf("statusId = %v", result["statusId"])
	}
	if result["time"] != "3.000" {
		t.Errorf("time = %v", result["time"])
	}
	if result["memory"] != int64(1) {
		t.Errorf("memory = %v", result["memory"])
	}
	if text, _ := result["error"].(string); !strings.Contains(text, "SIGKILL") {
		t.Errorf("error = %q", result["error"])
	}
}

func TestCompileFailureTakesPrecedenceOverCompatibilityRunField(t *testing.T) {
	stage := `{"stdout":"", "stderr":"syntax error", "code":1}`
	result := normalizePiston(t, `{"compile":`+stage+`, "run":`+stage+`}`)
	if result["statusId"] != 6 {
		t.Errorf("statusId = %v", result["statusId"])
	}
	if result["error"] != "syntax error" {
		t.Errorf("error = %q", result["error"])
	}
}

func TestDistinguishesRuntimeFailureAndMissingResult(t *testing.T) {
	result := normalizePiston(t, `{"run":{"stdout":"before crash", "stderr":"exception", "code":1}}`)
	if result["statusId"] != 11 {
		t.Errorf("statusId = %v", result["statusId"])
	}
	if got := normalizePiston(t, `{}`)["statusId"]; got != 13 {
		t.Errorf("statusId of no result = %v", got)
	}
}

func TestResolvesCppAliasAndUsesSourceExtensions(t *testing.T) {
	if got := mapLanguage("cpp"); got != "c++" {
		t.Errorf("mapLanguage(cpp) = %q", got)
	}
	if got := fileExtension(mapLanguage("cpp")); got != "cpp" {
		t.Errorf("extension of cpp = %q", got)
	}
	if got := fileExtension(mapLanguage("typescript")); got != "ts" {
		t.Errorf("extension of typescript = %q", got)
	}
	if got := fileExtension(mapLanguage("c")); got != "c" {
		t.Errorf("extension of c = %q", got)
	}
}
