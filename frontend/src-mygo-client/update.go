package main

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/egoist/mygo"
	"sharecode/client/internal/updates"
)

var updateNodes = []string{"https://kode666.com", "https://collabcode.cc"}

// updater holds the releases the page has found, under the IDs it refers to
// them by (src/lib/mygo-updater.ts).
type updater struct {
	mu        sync.Mutex
	found     map[string]*foundUpdate
	installed bool // an installer is running; it restarts the client
}

type foundUpdate struct {
	release updates.Release
	dir     string // the download's own directory under updatesDir
	path    string // the verified installer, once downloaded
}

func updateClient() *updates.Client {
	arch := map[string]string{"amd64": "x86_64", "386": "i686", "arm64": "aarch64"}[runtime.GOARCH]
	var endpoints []string
	for _, node := range updateNodes {
		endpoints = append(endpoints, fmt.Sprintf("%s/api/client/update/%s/%s/%s", node, runtime.GOOS, arch, applicationVersion))
	}
	client := updates.New(endpoints)
	client.CurrentVersion = applicationVersion
	return client
}

func isUpdateCommand(command string) bool {
	return strings.HasPrefix(command, "client_update_") || command == "client_relaunch"
}

// updateCommand runs off the UI thread: checks and downloads use the network.
func (d *Desktop) updateCommand(ctx context.Context, command string, args map[string]any) (any, error) {
	u := &d.updates
	switch command {
	case "client_update_check":
		ctx, cancel := context.WithTimeout(ctx, timeoutArg(args, 30*time.Second))
		defer cancel()
		release, err := updateClient().Check(ctx)
		if err != nil || release == nil {
			return nil, err
		}
		id := rand.Text()
		u.mu.Lock()
		if u.found == nil {
			u.found = map[string]*foundUpdate{}
		}
		u.found[id] = &foundUpdate{release: *release}
		u.mu.Unlock()
		return map[string]any{"id": id, "currentVersion": applicationVersion, "version": release.Version, "body": release.Notes, "date": release.Date}, nil
	case "client_relaunch":
		u.mu.Lock()
		installed := u.installed
		u.mu.Unlock()
		if !installed {
			return nil, errors.New("no update has been installed")
		}
		// The installer waits for this process to exit and starts the new one.
		mygo.RunOnMain(d.beginShutdown)
		return nil, nil
	}
	id, err := stringArg(args, "id")
	if err != nil {
		return nil, err
	}
	switch command {
	case "client_update_download":
		ctx, cancel := context.WithTimeout(ctx, timeoutArg(args, 5*time.Minute))
		defer cancel()
		return nil, u.download(ctx, id, func(p updates.Progress) {
			d.emit("sharecode:update-download", map[string]any{"id": id, "event": p.Event, "data": p.Data})
		})
	case "client_update_install":
		return nil, u.install(id)
	case "client_update_close":
		u.close(id)
		return nil, nil
	}
	return nil, fmt.Errorf("unknown updater command %q", command)
}

func (u *updater) download(ctx context.Context, id string, progress func(updates.Progress)) error {
	u.mu.Lock()
	found := u.found[id]
	u.mu.Unlock()
	if found == nil {
		return errors.New("update is closed")
	}
	base, err := updatesDir()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(base, 0o700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(base, "sharecode-update-")
	if err != nil {
		return err
	}
	path, err := updateClient().Download(ctx, found.release, dir, progress)
	u.mu.Lock()
	defer u.mu.Unlock()
	if err == nil && (u.found[id] != found || found.path != "") {
		err = errors.New("update was closed or already downloaded")
	}
	if err != nil {
		os.RemoveAll(dir)
		return err
	}
	found.dir, found.path = dir, path
	return nil
}

func (u *updater) install(id string) error {
	// A development build has its own identity and must not run the released
	// client's installer over a real installation.
	if applicationID != productionID {
		return errors.New("development builds do not install updates")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	found := u.found[id]
	if found == nil || found.path == "" {
		return errors.New("update has not been downloaded")
	}
	if u.installed {
		return errors.New("an installer is already running")
	}
	if err := updates.Install(found.path); err != nil {
		return err
	}
	u.installed = true
	delete(u.found, id) // the running installer keeps its file
	return nil
}

// updatesDir is where installers are downloaded to, verified and started
// from: beside the executable, under Program Files. This process is elevated
// and so is the installer it starts; in the user's temporary folder a process
// without administrator rights could replace the file after it was verified.
func updatesDir() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), "updates"), nil
}

// clearUpdates removes the installers of earlier updates, at launch: an
// installer cannot remove the file it runs from.
func clearUpdates() {
	if dir, err := updatesDir(); err == nil {
		os.RemoveAll(dir)
	}
}

func (u *updater) close(id string) {
	u.mu.Lock()
	found := u.found[id]
	delete(u.found, id)
	u.mu.Unlock()
	if found != nil && found.dir != "" {
		os.RemoveAll(found.dir)
	}
}

// closeAll drops every update the page found: its document is gone.
func (u *updater) closeAll() {
	u.mu.Lock()
	ids := make([]string, 0, len(u.found))
	for id := range u.found {
		ids = append(ids, id)
	}
	u.mu.Unlock()
	for _, id := range ids {
		u.close(id)
	}
}

func timeoutArg(args map[string]any, limit time.Duration) time.Duration {
	if ms, ok := args["timeout"].(float64); ok && ms > 0 && ms <= float64(limit.Milliseconds()) {
		return time.Duration(ms) * time.Millisecond
	}
	return limit
}
