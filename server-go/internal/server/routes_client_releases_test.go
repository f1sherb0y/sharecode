package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// A throwaway `tauri signer` key (discarded) and its signature of testPayload.
const (
	testPubkey    = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEI4NEZDMzdBMzFFRjY0MkMKUldRc1pPOHhlc05QdUpFSVpoQ0R3NmVvbXNnRDZYWHBNUVJ5MjdFVTFza1BrbXRaNHV1aDQxdTYK"
	testPayload   = "hello update"
	testSignature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVRc1pPOHhlc05QdUhoaWZ3K1JtM2N2VUxJUDNJYkNRN2M3NllnMkVoQ1o1N2w0VDJsaDFQRUJEOGxkVVdERzJUQUVreEE1bkdFQ3NCanRzM2NWaGg1aGYxTzF0R3RubGdrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODM5ODY2CWZpbGU6dW5pdC5iaW4KdXRhK090dDFvVTN4dGZBV3RNSHdWbkp6NndBc053NHNNcG1MYVEvVG1WdTJWVk55Yk9mVXpkbmg4RnAydzhSVjBVTmFNSHIvYklTTTF5ZENPRnJTQXc9PQo="
)

func testRelease(id, version string) ReleaseRow {
	now := time.Now().UTC()
	return ReleaseRow{ID: id, Version: version, PublishedAt: &now, CreatedAt: now, UpdatedAt: now}
}

func testAsset(releaseID, platform, kind string, signed bool) AssetRow {
	asset := AssetRow{
		ID:        fmt.Sprintf("%s-%s-%s", releaseID, platform, kind),
		ReleaseID: releaseID,
		Platform:  platform,
		Kind:      kind,
		FileName:  "file",
		Size:      1,
		CreatedAt: time.Now().UTC(),
	}
	if signed {
		asset.Signature = ptr("sig")
	}
	return asset
}

func testReleaseConfig() *Config {
	config := ConfigFromEnv()
	config.ClientUpdaterPubkey = testPubkey
	config.AppURL = ptr("https://collabcode.cc")
	config.FrontendURL = nil
	config.AllowedOrigins = []string{"https://kode666.com", "http://127.0.0.1:55461"}
	return config
}

func TestVersionsAreSemantic(t *testing.T) {
	version, err := parseVersion(" 1.2.3 ")
	if err != nil || version.String() != "1.2.3" {
		t.Fatalf("parseVersion(\" 1.2.3 \") = %v, %v", version, err)
	}
	if _, err := parseVersion("0.2.0-beta.1"); err != nil {
		t.Fatal("0.2.0-beta.1 must parse")
	}
	if _, err := parseVersion("v1.2.3"); err == nil {
		t.Fatal("v1.2.3 must not parse")
	}
	if _, err := parseVersion("1.2"); err == nil {
		t.Fatal("1.2 must not parse")
	}
}

// Not in the Rust file: the semver crate's parsing and order, which this
// port implements itself.
func TestSemverMatchesTheRustCrate(t *testing.T) {
	for _, invalid := range []string{"", "1", "1.2.", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "1.2.3-a..b", "1.2.3+", "1.2.3 ", "1.2.3-a_b", "18446744073709551616.0.0"} {
		if _, ok := parseSemver(invalid); ok {
			t.Errorf("%q must not parse", invalid)
		}
	}
	for _, valid := range []string{"0.0.0", "1.2.3-0", "1.2.3-0a", "1.2.3-alpha.1+build.001", "1.2.3+001", "18446744073709551615.0.0", "1.0.0--"} {
		version, ok := parseSemver(valid)
		if !ok || version.String() != valid {
			t.Errorf("%q parsed as %v, %v", valid, version, ok)
		}
	}
	// Each version is less than the next.
	ordered := []string{
		"0.9.9", "1.0.0-1", "1.0.0-2", "1.0.0-10", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
		"1.0.0-rc.1", "1.0.0", "1.0.0+0", "1.0.0+00", "1.0.0+1", "1.0.0+01", "1.0.0+2", "1.0.0+10", "1.0.0+a",
		"1.0.1", "1.1.0", "2.0.0", "10.0.0",
	}
	for i := range ordered {
		for j := range ordered {
			a, _ := parseSemver(ordered[i])
			b, _ := parseSemver(ordered[j])
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := a.cmp(b); got != want {
				t.Errorf("cmp(%s, %s) = %d, want %d", ordered[i], ordered[j], got, want)
			}
		}
	}
}

func TestFileNamesKeepOnlyTheLastComponent(t *testing.T) {
	sanitized := func(name string) string {
		result, ok := sanitizeFileName(name)
		if !ok {
			return "<none>"
		}
		return result
	}
	if got := sanitized(`C:\fakepath\ShareCode Client_0.2.0_x64-setup.exe`); got != "ShareCode Client_0.2.0_x64-setup.exe" {
		t.Errorf("got %q", got)
	}
	if got := sanitized("../../etc/passwd"); got != "passwd" {
		t.Errorf("got %q", got)
	}
	if got := sanitized("a\x00b\n.dmg"); got != "ab.dmg" {
		t.Errorf("got %q", got)
	}
	if got := sanitized(".."); got != "<none>" {
		t.Errorf("got %q", got)
	}
	if got := sanitized("dir/"); got != "<none>" {
		t.Errorf("got %q", got)
	}
	if !hasReleaseExtension("ShareCode Client_0.2.0_aarch64.app.tar.gz") {
		t.Error(".app.tar.gz must be accepted")
	}
	if !hasReleaseExtension("ShareCode Client_0.2.0_amd64.AppImage") {
		t.Error(".AppImage must be accepted")
	}
	if hasReleaseExtension("ShareCode Client_0.2.0_x64-setup.exe.sig") {
		t.Error(".sig must not be accepted")
	}
}

func TestSignaturesAreCheckedLikeTheUpdaterDoes(t *testing.T) {
	config := testReleaseConfig()
	key, err := updaterPublicKey(config)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(os.TempDir(), "sharecode-signature-test-"+uuid.NewString())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	signed := filepath.Join(dir, "signed")
	tampered := filepath.Join(dir, "tampered")
	if err := os.WriteFile(signed, []byte(testPayload), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(tampered, []byte(testPayload+"!"), 0o644); err != nil {
		t.Fatal(err)
	}

	text, signature, err := parseSignature(" " + testSignature + "\n")
	if err != nil {
		t.Fatal(err)
	}
	if text != testSignature {
		t.Errorf("signature text = %q", text)
	}
	if err := verifySignature(key, signature, signed); err != nil {
		t.Errorf("the signed file must verify: %v", err)
	}
	if err := verifySignature(key, signature, tampered); err == nil {
		t.Error("the tampered file must not verify")
	}

	// Well-formed signatures made with another key (here: checked against the real one).
	production := *config
	production.ClientUpdaterPubkey = ClientUpdaterPubkeyDefault
	productionKey, err := updaterPublicKey(&production)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifySignature(productionKey, signature, signed); err == nil {
		t.Error("another key must not verify")
	}

	if _, _, err := parseSignature("not base64!"); err == nil {
		t.Error("not base64 must be refused")
	}
	if _, _, err := parseSignature(base64.StdEncoding.EncodeToString([]byte("hello"))); err == nil {
		t.Error("base64 of something else must be refused")
	}
	if _, _, err := parseSignature(""); err == nil {
		t.Error("an empty signature must be refused")
	}
}

func TestTheServerTrustsTheClientsUpdateKey(t *testing.T) {
	raw, err := os.ReadFile("../../../frontend/src-tauri-client/tauri.conf.json")
	if err != nil {
		t.Fatal(err)
	}
	var tauriConfig struct {
		Plugins struct {
			Updater struct {
				Pubkey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &tauriConfig); err != nil {
		t.Fatal(err)
	}
	if tauriConfig.Plugins.Updater.Pubkey != ClientUpdaterPubkeyDefault {
		t.Errorf("tauri.conf.json pubkey = %q", tauriConfig.Plugins.Updater.Pubkey)
	}
}

func TestUpdatesComeFromTheNewestSignedReleasePerPlatform(t *testing.T) {
	releases := []ReleaseRow{testRelease("r3", "0.3.0"), testRelease("r2", "0.2.0"), testRelease("r1", "0.1.0")}
	assets := []AssetRow{
		// 0.3.0's Windows installer is unsigned, so it is no update.
		testAsset("r3", "windows-x86_64", "installer", false),
		testAsset("r2", "windows-x86_64", "installer", true),
		// macOS updates use the update bundle only, never the .dmg installer.
		testAsset("r3", "darwin-aarch64", "installer", true),
		testAsset("r2", "darwin-aarch64", "update", true),
		testAsset("r1", "linux-x86_64", "installer", true),
	}
	pick := func(platform string) string {
		release, asset := pickUpdate(releases, assets, platform)
		if release == nil {
			return "<none>"
		}
		return release.Version + " " + asset.Kind
	}
	for platform, want := range map[string]string{
		"windows-x86_64": "0.2.0 installer",
		"darwin-aarch64": "0.2.0 update",
		"linux-x86_64":   "0.1.0 installer",
		"darwin-x86_64":  "<none>",
	} {
		if got := pick(platform); got != want {
			t.Errorf("pick(%s) = %s, want %s", platform, got, want)
		}
	}
}

func TestUpdateURLsUseTheNodeTheClientReached(t *testing.T) {
	config := testReleaseConfig()
	for host, want := range map[string]string{
		"kode666.com":     "https://kode666.com",
		"KODE666.com":     "https://kode666.com",
		"127.0.0.1:55461": "http://127.0.0.1:55461",
		// Unknown hosts get the main origin, never their own.
		"evil.invalid": "https://collabcode.cc",
		"":             "https://collabcode.cc",
	} {
		if got, ok := publicOrigin(config, host); !ok || got != want {
			t.Errorf("publicOrigin(%q) = %q, %v, want %q", host, got, ok, want)
		}
	}
}

func TestInstallScriptsCarryTheNewestInstallerPerArchitecture(t *testing.T) {
	releases := []ReleaseRow{testRelease("r2", "0.2.0"), testRelease("r1", "0.1.0")}
	assets := []AssetRow{
		testAsset("r2", "darwin-x86_64", "installer", true),
		testAsset("r1", "darwin-aarch64", "installer", true),
		// Update bundles are never what the scripts install.
		testAsset("r2", "darwin-aarch64", "update", true),
		testAsset("r2", "windows-x86_64", "installer", true),
	}
	for i := range assets {
		assets[i].SHA256 = strings.Repeat("0", 64-len(assets[i].ReleaseID)) + assets[i].ReleaseID
	}
	render := func(template, os string) string {
		script, err := renderInstallScript(template, "https://kode666.com", releases, assets, os)
		if err != nil {
			t.Fatal(err)
		}
		return script
	}
	for _, script := range []string{render(macosInstallScriptTemplate, "darwin"), render(windowsInstallScriptTemplate, "windows")} {
		if strings.Contains(script, "{{") || strings.Contains(script, "\r") {
			t.Error("unfilled placeholder or CR")
		}
		if !strings.Contains(script, "https://kode666.com/api/client/install.") {
			t.Error("the script must name its own URL")
		}
	}
	mac := render(macosInstallScriptTemplate, "darwin")
	// Apple silicon gets its own newest installer (0.1.0) even though Intel has 0.2.0.
	for _, want := range []string{
		"version='0.1.0' url='/api/client/downloads/r1-darwin-aarch64-installer/file'",
		"version='0.2.0' url='/api/client/downloads/r2-darwin-x86_64-installer/file'",
		"ORIGIN='https://kode666.com'",
	} {
		if !strings.Contains(mac, want) {
			t.Errorf("the macOS script lacks %q", want)
		}
	}
	// Windows on Arm falls back to the x64 installer; nothing published leaves the URL empty.
	windows := render(windowsInstallScriptTemplate, "windows")
	if got := strings.Count(windows, "$url = '/api/client/downloads/r2-windows-x86_64-installer/file'"); got != 2 {
		t.Errorf("the Windows script names the x64 installer %d times, want 2", got)
	}
	empty, err := renderInstallScript(windowsInstallScriptTemplate, "https://kode666.com", releases, nil, "windows")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(empty, "$url = ''"); got != 2 {
		t.Errorf("the empty Windows script has %d empty URLs, want 2", got)
	}
}

func TestDownloadURLsAndNamesAreEncoded(t *testing.T) {
	asset := testAsset("r", "windows-x86_64", "installer", false)
	asset.FileName = "ShareCode Client_0.2.0_x64-setup.exe"
	if got, want := downloadPath(&asset), "/api/client/downloads/r-windows-x86_64-installer/ShareCode%20Client_0.2.0_x64-setup.exe"; got != want {
		t.Errorf("downloadPath = %q, want %q", got, want)
	}
	if got, want := contentDisposition("客户端 \"setup\".exe"), "attachment; filename=\"___ _setup_.exe\"; filename*=UTF-8''%E5%AE%A2%E6%88%B7%E7%AB%AF%20%22setup%22.exe"; got != want {
		t.Errorf("contentDisposition = %q, want %q", got, want)
	}
}

// Not in the Rust file: multer's reading of Content-Disposition, which this
// port implements itself (cases from multer's own tests).
func TestContentDispositionIsReadLikeMulter(t *testing.T) {
	for _, c := range []struct{ header, name, fileName string }{
		{`form-data; name="my_field"`, "my_field", "<none>"},
		{`form-data; name=my_field  `, "my_field", "<none>"},
		{`form-data; name  =  my_field  `, "my_field", "<none>"},
		{`form-data; name="my_field"; filename="file abc.txt"`, "my_field", "file abc.txt"},
		{`form-data; filename="file-name.txt"`, "<none>", "file-name.txt"},
		{`form-data; name="file"; filename="C:\fakepath\a \"b\".exe"`, "file", `C:\fakepath\a "b".exe`},
		{`form-data; name="file"; filename="dir/"`, "file", "dir/"},
	} {
		read := func(prefix string) string {
			value, ok := contentDispositionAttr(c.header, prefix)
			if !ok {
				return "<none>"
			}
			return value
		}
		if got := read("name"); got != c.name {
			t.Errorf("name of %q = %q, want %q", c.header, got, c.name)
		}
		if got := read("filename"); got != c.fileName {
			t.Errorf("filename of %q = %q, want %q", c.header, got, c.fileName)
		}
	}
}
