//go:build windows

package nativewin

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

type fixture struct {
	cmd     *exec.Cmd
	in      io.WriteCloser
	lines   chan string
	windows []fixtureWindow
}
type fixtureWindow struct {
	hwnd            uintptr
	style, affinity uint32
}

func startFixture(t *testing.T, path string) *fixture {
	t.Helper()
	cmd := exec.Command(path)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000, HideWindow: true}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	f := &fixture{cmd: cmd, in: in, lines: make(chan string, 1)}
	go func() {
		defer close(f.lines)
		s := bufio.NewScanner(out)
		for s.Scan() {
			f.lines <- s.Text()
		}
	}()
	t.Cleanup(func() { in.Close(); cmd.Process.Kill(); cmd.Wait() })
	f.read(t)
	return f
}
func (f *fixture) read(t *testing.T) {
	t.Helper()
	select {
	case line := <-f.lines:
		f.windows = nil
		for _, part := range strings.Fields(line) {
			fields := strings.Split(part, ":")
			if len(fields) != 4 {
				t.Fatalf("invalid fixture report: %q", line)
			}
			h, _ := strconv.ParseUint(fields[0], 10, 64)
			s, _ := strconv.ParseUint(fields[1], 10, 32)
			a, _ := strconv.ParseUint(fields[2], 10, 32)
			f.windows = append(f.windows, fixtureWindow{uintptr(h), uint32(s), uint32(a)})
		}
		if len(f.windows) != 7 {
			t.Fatalf("expected seven isolated fixture windows, got %d", len(f.windows))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("fixture response timeout")
	}
}
func (f *fixture) command(t *testing.T, c string) {
	t.Helper()
	if _, err := fmt.Fprintln(f.in, c); err != nil {
		t.Fatal(err)
	}
	f.read(t)
}
func TestMeetingIsolatedBothArchitectures(t *testing.T) {
	root := os.Getenv("NATIVEWIN_FIXTURES")
	if root == "" {
		t.Skip("run nativewin/test-meeting.ps1 for isolated x86/x64 integration")
	}
	if !DefaultHelperAssets.complete() {
		t.Fatal("run build-helpers.ps1 first")
	}
	a := startFixture(t, filepath.Join(root, "x86", "voovmeetingapp.exe"))
	b := startFixture(t, filepath.Join(root, "x64", "wemeetapp.exe"))
	m, err := NewMeetingMonitor(MeetingOptions{CacheDir: t.TempDir(), Assets: DefaultHelperAssets, TestProcessIDs: []uint32{uint32(a.cmd.Process.Pid), uint32(b.cmd.Process.Pid)}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	enable := func() {
		t.Helper()
		s, e := m.Enable(true)
		if e != nil || s.State != "active" || s.MeetingProcesses != 2 {
			t.Fatalf("enable: %+v %v", s, e)
		}
		for _, f := range []*fixture{a, b} {
			for _, w := range f.windows {
				v, e := readAffinity(w.hwnd)
				if e != nil || v != 17 {
					t.Fatalf("fixture affinity %d: %d %v", w.hwnd, v, e)
				}
			}
		}
	}
	enable()
	a.command(t, "reset")
	b.command(t, "recreate")
	enable()
	a.command(t, "show")
	b.command(t, "rename")
	enable()
	// External modifications during protection survive independent restoration.
	a.command(t, "external")
	s, err := m.Enable(false)
	if err != nil || s.State != "disabled" {
		t.Fatalf("disable %+v %v", s, err)
	}
	for _, f := range []*fixture{a, b} {
		for i, w := range f.windows {
			expected := w.affinity
			if f == a && i == 0 {
				expected = 1
			}
			v, e := readAffinity(w.hwnd)
			if e != nil || v != expected {
				t.Fatalf("restore HWND %d: %d != %d (%v)", w.hwnd, v, expected, e)
			}
			style, _, _ := getWindowLong.Call(w.hwnd, gwlExStyle)
			if uint32(style)&toolBits != w.style&toolBits {
				t.Fatalf("taskbar bits not restored HWND %d: %#x", w.hwnd, style)
			}
		}
	}
}
