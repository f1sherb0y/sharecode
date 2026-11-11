package updates

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"aead.dev/minisign"
)

func fixture(t *testing.T) (*Client, Release, []byte, *bool) {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	data := bytes.Repeat([]byte("signed installer bytes\n"), 10000)
	reader := minisign.NewReader(bytes.NewReader(data))
	io.Copy(io.Discard, reader)
	sig := base64.StdEncoding.EncodeToString(reader.Sign(priv))
	key, _ := pub.MarshalText()
	corrupt := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if corrupt {
			w.Write([]byte("tampered"))
			return
		}
		w.Write(data)
	}))
	t.Cleanup(server.Close)
	c := New(nil)
	c.HTTP = server.Client()
	c.AllowHTTP = true
	c.PublicKey = base64.StdEncoding.EncodeToString(key)
	return c, Release{Version: "0.2.8", URL: server.URL, Signature: sig}, data, &corrupt
}
func TestVerifiedDownload(t *testing.T) {
	c, r, data, _ := fixture(t)
	dir := t.TempDir()
	var events []Progress
	path, err := c.Download(context.Background(), r, dir, func(p Progress) { events = append(events, p) })
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("download mismatch: %v", err)
	}
	if events[0].Event != "Started" || events[len(events)-1].Event != "Finished" {
		t.Fatal(events)
	}
	var received int64
	for _, p := range events {
		received += p.Data["chunkLength"]
	}
	if received != int64(len(data)) {
		t.Fatal(received)
	}
}
func TestTamperedDownloadNeverFinishesAndRemovesFile(t *testing.T) {
	c, r, _, corrupt := fixture(t)
	*corrupt = true
	dir := t.TempDir()
	finished := false
	_, err := c.Download(context.Background(), r, dir, func(p Progress) { finished = finished || p.Event == "Finished" })
	if err == nil || finished {
		t.Fatal("tampered update accepted")
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*"))
	if len(files) != 0 {
		t.Fatal(files)
	}
}
func TestCheckFallbackAndExplicitNoUpdate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/current" {
			w.WriteHeader(204)
		} else {
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	c := New([]string{server.URL + "/fail", server.URL + "/current"})
	c.HTTP = server.Client()
	c.AllowHTTP = true
	r, err := c.Check(context.Background())
	if err != nil || r != nil {
		t.Fatalf("%v %v", r, err)
	}
	c.Endpoints = c.Endpoints[:1]
	if _, err = c.Check(context.Background()); err == nil {
		t.Fatal("network failure treated as current")
	}
}
func TestCheckMetadata(t *testing.T) {
	c, release, _, _ := fixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(release) }))
	defer server.Close()
	c.Endpoints = []string{server.URL}
	got, err := c.Check(context.Background())
	if err != nil || got.Version != release.Version {
		t.Fatalf("%v %v", got, err)
	}
	release.Signature = "malformed"
	if _, err = c.Check(context.Background()); err == nil {
		t.Fatal("malformed signature accepted")
	}
}
func TestCheckDoesNotDowngradeOrReinstallSameVersion(t *testing.T) {
	c, release, _, _ := fixture(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(release) }))
	defer server.Close()
	c.Endpoints = []string{server.URL}
	c.CurrentVersion = "0.2.8"
	for _, version := range []string{"0.2.7", "0.2.8-beta.1", "0.2.8", "0.2.8+build.2"} {
		release.Version = version
		if got, err := c.Check(context.Background()); err != nil || got != nil {
			t.Fatalf("%s: %v %v", version, got, err)
		}
	}
	release.Version = "0.2.10"
	if got, err := c.Check(context.Background()); err != nil || got == nil {
		t.Fatalf("new release: %v %v", got, err)
	}
	release.Version = "0.2.09"
	if _, err := c.Check(context.Background()); err == nil {
		t.Fatal("malformed feed version accepted")
	}
}

func TestPublicKeyMatchesTauri(t *testing.T) {
	raw, err := os.ReadFile("../../../src-tauri-client/tauri.conf.json")
	if err != nil {
		t.Fatal(err)
	}
	var conf struct {
		Plugins struct {
			Updater struct {
				Pubkey string `json:"pubkey"`
			} `json:"updater"`
		} `json:"plugins"`
	}
	if err = json.Unmarshal(raw, &conf); err != nil {
		t.Fatal(err)
	}
	if conf.Plugins.Updater.Pubkey != PublicKey {
		t.Fatal("update trust key diverged")
	}
}
func TestUnsafeURLsRejected(t *testing.T) {
	c := New(nil)
	for _, raw := range []string{"http://example.com/update", "file:///tmp/update", "https://user:pass@example.com/update", "https:///empty"} {
		if err := c.validURL(raw); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	c.AllowHTTP = true
	if err := c.validURL("http://example.com/update"); err == nil {
		t.Fatal("test mode allowed non-loopback HTTP")
	}
}
