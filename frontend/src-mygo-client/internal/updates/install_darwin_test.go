//go:build darwin

package updates

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type entry struct {
	name, body, link string
	mode             int64
}

func archiveOf(t *testing.T, entries ...entry) string {
	t.Helper()
	var data bytes.Buffer
	compressed := gzip.NewWriter(&data)
	out := tar.NewWriter(compressed)
	for _, e := range entries {
		header := &tar.Header{Name: e.name, Mode: e.mode, Size: int64(len(e.body)), Typeflag: tar.TypeReg}
		switch {
		case e.link != "":
			header.Typeflag, header.Linkname, header.Size = tar.TypeSymlink, e.link, 0
		case strings.HasSuffix(e.name, "/"):
			header.Typeflag, header.Size = tar.TypeDir, 0
		}
		if err := out.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := out.Write([]byte(e.body)); err != nil && header.Typeflag == tar.TypeReg {
			t.Fatal(err)
		}
	}
	out.Close()
	compressed.Close()
	path := filepath.Join(t.TempDir(), "update.app.tar.gz")
	if err := os.WriteFile(path, data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The app in the archive has another name than the installed one, as a
// development build's does: the installed bundle keeps its path.
func update(version string) []entry {
	return []entry{
		{name: "Other Name.app/", mode: 0o755},
		{name: "Other Name.app/Contents/", mode: 0o755},
		{name: "Other Name.app/Contents/Info.plist", body: version, mode: 0o644},
		{name: "Other Name.app/Contents/MacOS/sharecode-client", body: "#!/bin/sh\n", mode: 0o755},
		{name: "Other Name.app/Contents/Resources/libsharecode_native.dylib", body: "library", mode: 0o755},
		{name: "Other Name.app/Contents/Resources/current", link: "libsharecode_native.dylib"},
	}
}

func installed(t *testing.T) string {
	t.Helper()
	bundle := filepath.Join(t.TempDir(), "ShareCode Client.app")
	for path, body := range map[string]string{"Contents/Info.plist": "0.2.7", "Contents/MacOS/sharecode-client": "old", "Contents/Resources/removed.txt": "old"} {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(bundle, path)), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bundle, path), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return bundle
}

func withoutSignatureCheck(t *testing.T, result error) *int {
	t.Helper()
	calls := 0
	previous := verifyBundle
	verifyBundle = func(string) error { calls++; return result }
	t.Cleanup(func() { verifyBundle = previous })
	return &calls
}

func version(t *testing.T, bundle string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(bundle, "Contents/Info.plist"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestAnUpdateReplacesTheBundleInPlace(t *testing.T) {
	checked := withoutSignatureCheck(t, nil)
	bundle := installed(t)
	if err := replaceBundle(archiveOf(t, update("0.2.8")...), bundle, "sharecode-client"); err != nil {
		t.Fatal(err)
	}
	if version(t, bundle) != "0.2.8" || *checked != 1 {
		t.Fatalf("version %s after %d signature checks", version(t, bundle), *checked)
	}
	if info, err := os.Stat(filepath.Join(bundle, "Contents/MacOS/sharecode-client")); err != nil || info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("the executable lost its mode: %v", err)
	}
	if target, err := os.Readlink(filepath.Join(bundle, "Contents/Resources/current")); err != nil || target != "libsharecode_native.dylib" {
		t.Fatalf("link: %q, %v", target, err)
	}
	if _, err := os.Stat(filepath.Join(bundle, "Contents/Resources/removed.txt")); !os.IsNotExist(err) {
		t.Fatal("a file of the old version survived")
	}
	// Nothing is left beside the app.
	if names, _ := os.ReadDir(filepath.Dir(bundle)); len(names) != 1 {
		t.Fatalf("left beside the app: %v", names)
	}
}

func TestARefusedUpdateLeavesTheInstalledAppAlone(t *testing.T) {
	bundle := installed(t)
	unsigned := errors.New("invalid signature")
	for name, test := range map[string]struct {
		entries []entry
		verify  error
	}{
		"bad signature":       {update("0.2.8"), unsigned},
		"another executable":  {[]entry{{name: "A.app/Contents/Info.plist", body: "0.2.8", mode: 0o644}, {name: "A.app/Contents/MacOS/other", body: "x", mode: 0o755}}, nil},
		"path outside":        {append(update("0.2.8"), entry{name: "../escaped", body: "x", mode: 0o644}), nil},
		"absolute path":       {append(update("0.2.8"), entry{name: "/tmp/sharecode-escaped", body: "x", mode: 0o644}), nil},
		"file beside the app": {append(update("0.2.8"), entry{name: "loose.txt", body: "x", mode: 0o644}), nil},
		"link outside":        {append(update("0.2.8"), entry{name: "A.app/Contents/escape", link: "../../../outside"}), nil},
		"absolute link":       {append(update("0.2.8"), entry{name: "A.app/Contents/escape", link: "/etc/hosts"}), nil},
		"empty archive":       {nil, nil},
	} {
		withoutSignatureCheck(t, test.verify)
		if err := replaceBundle(archiveOf(t, test.entries...), bundle, "sharecode-client"); err == nil {
			t.Fatalf("%s: the update was installed", name)
		}
		if version(t, bundle) != "0.2.7" {
			t.Fatalf("%s: the installed app changed", name)
		}
		if names, _ := os.ReadDir(filepath.Dir(bundle)); len(names) != 1 {
			t.Fatalf("%s: left beside the app: %v", name, names)
		}
	}
	if err := replaceBundle(filepath.Join(t.TempDir(), "missing"), bundle, "sharecode-client"); err == nil {
		t.Fatal("a missing archive was installed")
	}
	plain := filepath.Join(t.TempDir(), "plain")
	if err := os.WriteFile(plain, []byte("not gzip"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := replaceBundle(plain, bundle, "sharecode-client"); err == nil || version(t, bundle) != "0.2.7" {
		t.Fatal("a file that is no archive was installed")
	}
}

func TestPathsAreQuotedForTheAdministratorPrompt(t *testing.T) {
	if got := shellQuote(`/Applications/It's "mine".app`); got != `'/Applications/It'\''s "mine".app'` {
		t.Fatal(got)
	}
	if got := appleScriptQuote(`a "b" \ c`); got != `"a \"b\" \\ c"` {
		t.Fatal(got)
	}
}

func TestOnlyAnAppBundleIsUpdatedOrRelaunched(t *testing.T) {
	// The test binary does not run from a bundle.
	if err := Install(archiveOf(t, update("0.2.8")...)); err == nil {
		t.Fatal("an update was installed outside an app bundle")
	}
	if err := Relaunch(); err == nil {
		t.Fatal("a relaunch was scheduled outside an app bundle")
	}
}
