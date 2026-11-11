//go:build darwin

package updates

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const downloadPattern = "sharecode-update-*.app.tar.gz"

// maxBundle bounds what an update archive may unpack to.
const maxBundle = int64(4 << 30)

// Install replaces the running app bundle with the one in a downloaded and
// verified update (.app.tar.gz, the archive the Tauri updater also installs).
// The bundle keeps its path and name, so the app's permissions, which macOS
// ties to its signature and identifier, carry over. Relaunch starts it.
func Install(archive string) error {
	bundle, executable, err := runningBundle()
	if err != nil {
		return err
	}
	return replaceBundle(archive, bundle, filepath.Base(executable))
}

func runningBundle() (bundle, executable string, err error) {
	if executable, err = os.Executable(); err != nil {
		return "", "", err
	}
	if executable, err = filepath.EvalSymlinks(executable); err != nil {
		return "", "", err
	}
	macos := filepath.Dir(executable)
	contents := filepath.Dir(macos)
	bundle = filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || filepath.Ext(bundle) != ".app" {
		return "", "", errors.New("updates are installed over an app bundle; this client does not run from one")
	}
	return bundle, executable, nil
}

// verifyBundle checks the unpacked app before it replaces the running one: a
// bundle whose signature does not verify would not launch.
var verifyBundle = func(app string) error {
	if out, err := exec.Command("/usr/bin/codesign", "--verify", "--deep", "--strict", app).CombinedOutput(); err != nil {
		return fmt.Errorf("the update's code signature does not verify: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// replaceBundle unpacks archive and swaps it into bundle's place. executable
// is the file in Contents/MacOS that a restart runs: the update must have it.
func replaceBundle(archive, bundle, executable string) error {
	// Beside the bundle, so that the swap is two renames on one volume.
	stage, err := os.MkdirTemp(filepath.Dir(bundle), ".sharecode-update-")
	authorize := false
	if err != nil {
		// The folder is not ours to write (a standard user's /Applications).
		if stage, err = os.MkdirTemp("", "sharecode-update-"); err != nil {
			return err
		}
		authorize = true
	}
	defer os.RemoveAll(stage)
	updated := filepath.Join(stage, "updated.app")
	if err = unpack(archive, updated); err != nil {
		return err
	}
	for _, required := range []string{"Contents/Info.plist", filepath.Join("Contents/MacOS", executable)} {
		if info, err := os.Stat(filepath.Join(updated, required)); err != nil || info.IsDir() {
			return fmt.Errorf("the update is not this app: it has no %s", required)
		}
	}
	if err = verifyBundle(updated); err != nil {
		return err
	}
	if !authorize {
		previous := filepath.Join(stage, "previous.app")
		switch err = os.Rename(bundle, previous); {
		case err == nil:
			if err = os.Rename(updated, bundle); err != nil {
				// Put the running app back: a failed update must leave it usable.
				if restore := os.Rename(previous, bundle); restore != nil {
					return errors.Join(err, restore)
				}
				return err
			}
		case errors.Is(err, os.ErrPermission):
			authorize = true
		default:
			return err
		}
	}
	if authorize {
		if err = replaceAsAdministrator(updated, bundle); err != nil {
			return err
		}
	}
	// A new modification time makes Launch Services read the bundle again.
	now := time.Now()
	_ = os.Chtimes(bundle, now, now)
	return nil
}

// unpack extracts an .app.tar.gz into destination without its top-level
// directory, whatever the app is called in the archive. Entries stay inside
// destination: no absolute paths, no "..", and links only to relative targets.
func unpack(archive, destination string) error {
	file, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("the update is not a gzip archive: %w", err)
	}
	defer compressed.Close()
	entries := tar.NewReader(compressed)
	var total int64
	for {
		header, err := entries.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(filepath.FromSlash(header.Name))
		if filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return fmt.Errorf("the update has an unsafe path: %s", header.Name)
		}
		_, inner, nested := strings.Cut(name, string(filepath.Separator))
		target := destination
		if nested {
			target = filepath.Join(destination, inner)
		}
		mode := header.FileInfo().Mode().Perm()
		switch header.Typeflag {
		case tar.TypeDir:
			if err = os.MkdirAll(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if !nested {
				return fmt.Errorf("the update has a file outside its app: %s", header.Name)
			}
			if total += header.Size; total > maxBundle {
				return errors.New("the update is too large")
			}
			if err = os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode|0o600)
			if err != nil {
				return err
			}
			if _, err = io.CopyN(out, entries, header.Size); err != nil {
				out.Close()
				return err
			}
			if err = out.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			link := filepath.FromSlash(header.Linkname)
			inside, err := filepath.Rel(destination, filepath.Join(filepath.Dir(target), link))
			if !nested || filepath.IsAbs(link) || err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) {
				return fmt.Errorf("the update has an unsafe link: %s", header.Name)
			}
			if err = os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err = os.Symlink(link, target); err != nil {
				return err
			}
		case tar.TypeXGlobalHeader, tar.TypeXHeader:
		default:
			return fmt.Errorf("the update has an unsupported entry: %s", header.Name)
		}
	}
	if _, err := os.Stat(destination); err != nil {
		return errors.New("the update archive is empty")
	}
	return nil
}

// shellQuote quotes a path for /bin/sh, and appleScriptQuote a string for
// AppleScript; a path passes through both.
func shellQuote(text string) string { return "'" + strings.ReplaceAll(text, "'", `'\''`) + "'" }

func appleScriptQuote(text string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(text) + `"`
}

// replaceAsAdministrator moves the update into place where the user may not
// write: macOS asks for an administrator's password, as the Tauri updater did.
func replaceAsAdministrator(updated, bundle string) error {
	command := "/bin/rm -rf " + shellQuote(bundle) + " && /bin/mv -f " + shellQuote(updated) + " " + shellQuote(bundle)
	script := "do shell script " + appleScriptQuote(command) + " with administrator privileges"
	if out, err := exec.Command("/usr/bin/osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("the update could not be moved into place: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// Relaunch arranges for the installed app to open once this process is gone;
// the caller quits next. Launch Services opens the bundle, so the new process
// is the app itself, with its own permissions, rather than a child of this one.
func Relaunch() error {
	bundle, _, err := runningBundle()
	if err != nil {
		return err
	}
	// Wait up to a minute for the exit, then open the app in any case.
	const script = `n=0; while /bin/kill -0 "$1" 2>/dev/null && [ "$n" -lt 600 ]; do /bin/sleep 0.1; n=$((n+1)); done; exec /usr/bin/open -n "$2"`
	cmd := exec.Command("/bin/sh", "-c", script, "sharecode-relaunch", strconv.Itoa(os.Getpid()), bundle)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
