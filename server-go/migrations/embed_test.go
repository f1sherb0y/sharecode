package migrations

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

var migrationName = regexp.MustCompile(`^\d+_[A-Za-z0-9_]+\.sql$`)

func names(t *testing.T) []string {
	t.Helper()
	entries, err := Files.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, entry := range entries {
		out = append(out, entry.Name())
	}
	sort.Strings(out)
	return out
}

func TestEveryMigrationIsNamedByVersionAndDescription(t *testing.T) {
	all := names(t)
	if len(all) == 0 {
		t.Fatal("no migrations are embedded")
	}
	for _, name := range all {
		if !migrationName.MatchString(name) {
			t.Errorf("%s is not <version>_<description>.sql", name)
		}
	}
}

// A database the Rust server migrated holds the checksum (SHA-384) of every
// file it applied, so the files here must stay byte for byte what server-rs
// has, for as long as it is in the tree.
func TestMigrationsAreTheRustServersByteForByte(t *testing.T) {
	rust := filepath.Join("..", "..", "server-rs", "migrations")
	entries, err := os.ReadDir(rust)
	if err != nil {
		t.Skip("server-rs is not in the tree")
	}
	var theirs []string
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) == ".sql" {
			theirs = append(theirs, entry.Name())
		}
	}
	sort.Strings(theirs)
	ours := names(t)
	// Migrations added after the move exist here only; none may be missing.
	have := map[string]bool{}
	for _, name := range ours {
		have[name] = true
	}
	for _, name := range theirs {
		if !have[name] {
			t.Errorf("%s is in server-rs but not here", name)
			continue
		}
		a, err := Files.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(rust, name))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(a, b) {
			t.Errorf("%s differs from server-rs (the applied checksum would no longer match)", name)
		}
	}
}
