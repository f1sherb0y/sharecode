package nativemac

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const diagnosticsLimit = 256 << 10

// Diagnostics is a small rotating log of the listener (macos-hotkey.jsonl).
// It holds states and action names, never keys. A nil log records nothing.
type Diagnostics struct {
	path string
	mu   sync.Mutex
}

func NewDiagnostics(directory string) (*Diagnostics, error) {
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(directory, "macos-hotkey.jsonl")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &Diagnostics{path: path}, file.Close()
}

func (d *Diagnostics) Record(event string, details any) {
	if d == nil {
		return
	}
	if err := d.write(event, details); err != nil {
		log.Printf("Hotkey diagnostics: %v", err)
	}
}

func (d *Diagnostics) write(event string, details any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	// At most two files of 256 KiB (plus the final record).
	if info, err := os.Stat(d.path); err == nil && info.Size() >= diagnosticsLimit {
		previous := d.path[:len(d.path)-len(".jsonl")] + ".previous.jsonl"
		if err := os.Rename(d.path, previous); err != nil {
			return err
		}
	}
	record, err := json.Marshal(map[string]any{
		"unixMs": time.Now().UnixMilli(), "pid": os.Getpid(), "event": event, "details": details,
	})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(d.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err = file.Write(append(record, '\n')); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}
