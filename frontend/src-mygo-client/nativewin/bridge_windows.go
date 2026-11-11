//go:build windows

package nativewin

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type helperHost struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	replies chan string
	done    chan struct{}
}

func materialize(dir, stem, ext string, data []byte) (string, error) {
	if len(data) == 0 {
		return "", errors.New("meeting helper assets missing; run nativewin/build-helpers.ps1")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	path := filepath.Join(dir, fmt.Sprintf("%s-%x.%s", stem, sum, ext))
	if existing, err := os.ReadFile(path); err == nil {
		if !bytes.Equal(existing, data) {
			return "", errors.New("meeting helper does not match this build")
		}
		return path, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	f, err := os.CreateTemp(dir, ".meeting-*")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err = os.Rename(tmp, path); err != nil {
		return "", err
	}
	return path, nil
}
func startHost(dir string, host, dll []byte) (*helperHost, error) {
	exe, err := materialize(dir, "meeting-bridge", "exe", host)
	if err != nil {
		return nil, err
	}
	lib, err := materialize(dir, "meeting-hook", "dll", dll)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(exe, lib)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW, HideWindow: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		in.Close()
		out.Close()
		return nil, err
	}
	h := &helperHost{cmd: cmd, input: in, replies: make(chan string, 1), done: make(chan struct{})}
	go func() {
		defer close(h.done)
		scanner := bufio.NewScanner(out)
		for scanner.Scan() {
			select {
			case h.replies <- scanner.Text():
			default:
				return
			}
		}
	}()
	return h, nil
}

// Command kinds of the helper protocol (meeting_window_bridge.rs).
const (
	helperAffinity     uint32 = 0
	helperTaskbarStyle uint32 = 1

	imageFileMachineI386  = 0x014c
	imageFileMachineAMD64 = 0x8664
)

var errMeetingThreadBlocked = errors.New("meeting thread/helper is unresponsive")

func (h *helperHost) close() {
	// Terminate first so a synchronous pipe writer cannot hold Close hostage.
	_ = h.cmd.Process.Kill()
	_ = h.input.Close()
	_ = h.cmd.Wait()
	<-h.done
}
func (h *helperHost) apply(w meetingWindow, kind, value uint32) error {
	// Bound both a blocked pipe write and response time. Caller discards this host
	// on every error, so a late response cannot satisfy the following command.
	answer := make(chan error, 1)
	go func() {
		_, err := fmt.Fprintf(h.input, "%d %d %d %d %d\n", w.hwnd, w.pid, w.thread, kind, value)
		answer <- err
	}()
	timer := time.NewTimer(750 * time.Millisecond)
	defer timer.Stop()
	select {
	case err := <-answer:
		if err != nil {
			return err
		}
	case <-timer.C:
		return fmt.Errorf("%w: write timed out", errMeetingThreadBlocked)
	}
	select {
	case reply := <-h.replies:
		if reply != "ok" {
			if strings.Contains(reply, "unresponsive window") {
				return fmt.Errorf("%w: %s", errMeetingThreadBlocked, reply)
			}
			return errors.New(reply)
		}
		return nil
	case <-h.done:
		return errors.New("meeting helper exited")
	case <-timer.C:
		return fmt.Errorf("%w: response timed out", errMeetingThreadBlocked)
	}
}

type meetingBridge struct {
	dir    string
	assets HelperAssets
	hosts  map[uint16]*helperHost
}

func (b *meetingBridge) close() {
	for _, h := range b.hosts {
		h.close()
	}
	b.hosts = make(map[uint16]*helperHost)
}
func (b *meetingBridge) apply(w meetingWindow, kind, value uint32) error {
	if !w.current() {
		return errors.New("meeting window changed before update")
	}
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, w.pid)
	if err != nil {
		return err
	}
	var machine, native uint16
	err = windows.IsWow64Process2(p, &machine, &native)
	windows.CloseHandle(p)
	if err != nil {
		return err
	}
	if machine == 0 {
		machine = native
	}
	var host, dll []byte
	switch machine {
	case imageFileMachineI386:
		host, dll = b.assets.X86Host, b.assets.X86DLL
	case imageFileMachineAMD64:
		host, dll = b.assets.X64Host, b.assets.X64DLL
	default:
		return fmt.Errorf("unsupported meeting architecture: %#x", machine)
	}
	h := b.hosts[machine]
	if h == nil {
		h, err = startHost(b.dir, host, dll)
		if err != nil {
			return err
		}
		b.hosts[machine] = h
	}
	if err = h.apply(w, kind, value); err != nil {
		h.close()
		delete(b.hosts, machine)
		return err
	}
	if !w.current() {
		return errors.New("meeting window changed before readback")
	}
	if kind == helperAffinity {
		actual, err := readAffinity(w.hwnd)
		if err != nil {
			return err
		}
		if actual != value {
			return errors.New("meeting affinity readback mismatch")
		}
	} else {
		if exStyle(w.hwnd)&toolBits != value {
			return errors.New("meeting taskbar readback mismatch")
		}
	}
	return nil
}
