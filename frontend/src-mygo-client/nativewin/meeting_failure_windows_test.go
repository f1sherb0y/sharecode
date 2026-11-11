//go:build windows

package nativewin

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func failureFixture(t *testing.T, arch string) *fixture {
	t.Helper()
	root := os.Getenv("NATIVEWIN_FIXTURES")
	if root == "" {
		t.Skip("run nativewin/test-meeting.ps1 for isolated native failure regressions")
	}
	if !DefaultHelperAssets.complete() {
		t.Fatal("native helper assets missing")
	}
	name := "wemeetapp.exe"
	if arch == "x86" {
		name = "voovmeetingapp.exe"
	}
	return startFixture(t, filepath.Join(root, arch, name))
}
func fixtureNativeWindow(t *testing.T, f *fixture, index int) meetingWindow {
	t.Helper()
	hwnd := f.windows[index].hwnd
	var pid uint32
	// Avoid using fixture metadata as native truth: snapshot the owner/thread now.
	thread, _, _ := getWindowThread.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	v, _, _ := isWindowVisible.Call(hwnd)
	style, _, _ := getWindowLong.Call(hwnd, gwlExStyle)
	if pid != uint32(f.cmd.Process.Pid) || thread == 0 {
		t.Fatal("fixture HWND ownership changed")
	}
	return meetingWindow{hwnd, pid, uint32(thread), uint32(style), v != 0}
}
func makeFixtureWorker(t *testing.T, fixtures ...*fixture) *meetingWorker {
	t.Helper()
	runtime.LockOSThread()
	t.Cleanup(runtime.UnlockOSThread)
	hr, _, _ := coInitializeEx.Call(0, 2)
	if int32(hr) < 0 {
		t.Fatalf("fixture COM init failed: %#x", hr)
	}
	t.Cleanup(func() { coUninitialize.Call() })
	pids := make([]uint32, 0, len(fixtures))
	for _, f := range fixtures {
		pids = append(pids, uint32(f.cmd.Process.Pid))
	}
	m := &MeetingMonitor{options: MeetingOptions{CacheDir: t.TempDir(), Assets: DefaultHelperAssets, TestProcessIDs: pids}}
	w := &meetingWorker{monitor: m, bridge: meetingBridge{dir: m.options.CacheDir, assets: DefaultHelperAssets, hosts: map[uint16]*helperHost{}}}
	t.Cleanup(func() {
		w.beforeShell = nil
		_ = w.tick(false)
		w.bridge.close()
		if w.shell != 0 {
			comCall(w.shell, 2)
		}
		if w.mutex != 0 {
			windows.ReleaseMutex(w.mutex)
			windows.CloseHandle(w.mutex)
		}
	})
	return w
}
func TestHelperCrashAndSuspendedHostRecover(t *testing.T) {
	for _, arch := range []string{"x86", "x64"} {
		t.Run(arch, func(t *testing.T) {
			// Register cache cleanup before fixture cleanup: Windows may keep a
			// previously injected DLL mapped until the isolated target exits.
			cache := t.TempDir()
			f := failureFixture(t, arch)
			window := fixtureNativeWindow(t, f, 1)
			b := meetingBridge{dir: cache, assets: DefaultHelperAssets, hosts: map[uint16]*helperHost{}}
			defer b.close()
			defer func() {
				if err := b.apply(window, 0, f.windows[1].affinity); err != nil {
					t.Error("fixture restore", err)
				}
			}()
			if err := b.apply(window, 0, 17); err != nil {
				t.Fatal(err)
			}
			machine := uint16(0x8664)
			if arch == "x86" {
				machine = 0x14c
			}
			host := b.hosts[machine]
			if err := host.cmd.Process.Kill(); err != nil {
				t.Fatal(err)
			}
			if err := b.apply(window, 0, 0); err == nil {
				t.Fatal("dead helper request claimed success")
			}
			if b.hosts[machine] != nil {
				t.Fatal("dead helper retained")
			}
			if err := b.apply(window, 0, 0); err != nil {
				t.Fatal("helper did not restart after crash", err)
			}
			host = b.hosts[machine]
			process, err := windows.OpenProcess(0x0800|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(host.cmd.Process.Pid))
			if err != nil {
				t.Fatal(err)
			}
			image := make([]uint16, 32768)
			size := uint32(len(image))
			if err = windows.QueryFullProcessImageName(process, 0, &image[0], &size); err != nil || !strings.EqualFold(windows.UTF16ToString(image[:size]), host.cmd.Path) {
				windows.CloseHandle(process)
				t.Fatal("refusing to suspend a process that is not the exact isolated helper", err)
			}
			// Suspend only the helper this test just started, never a meeting process or
			// another application. No hook is active between bounded helper requests.
			status, _, _ := windows.NewLazySystemDLL("ntdll.dll").NewProc("NtSuspendProcess").Call(uintptr(process))
			windows.CloseHandle(process)
			if int32(status) < 0 {
				t.Fatalf("could not suspend isolated helper: %#x", status)
			}
			start := time.Now()
			err = b.apply(window, 0, 17)
			elapsed := time.Since(start)
			if !errors.Is(err, errMeetingThreadBlocked) {
				t.Fatalf("suspended helper did not timeout: %v", err)
			}
			if elapsed > 2*time.Second {
				t.Fatalf("suspended helper cleanup exceeded bound: %v", elapsed)
			}
			if b.hosts[machine] != nil {
				t.Fatal("hung helper retained, late reply may poison subsequent commands")
			}
			if err = b.apply(window, 0, 17); err != nil {
				t.Fatal("helper restart after timeout failed", err)
			}
			value, err := readAffinity(window.hwnd)
			if err != nil || value != 17 {
				t.Fatalf("native readback after recovery: %d %v", value, err)
			}
		})
	}
}
func TestTaskbarShellFailureRetriesAndDoesNotStarveCapture(t *testing.T) {
	f := failureFixture(t, "x64")
	w := makeFixtureWorker(t, f)
	failures := 1
	w.beforeShell = func() error {
		if failures > 0 {
			failures--
			return errors.New("isolated injected Explorer failure")
		}
		return nil
	}
	status := w.tick(true)
	if status.State != "partial" {
		t.Fatalf("expected partial shell failure: %+v", status)
	}
	for _, fixtureWindow := range f.windows {
		v, err := readAffinity(fixtureWindow.hwnd)
		if err != nil || v != 17 {
			t.Fatalf("shell error starved independent capture: %#x => %d %v", fixtureWindow.hwnd, v, err)
		}
	}
	w.beforeShell = nil
	if s := w.tick(true); s.State != "active" {
		t.Fatalf("protection did not repair: %+v", s)
	}
	window := fixtureNativeWindow(t, f, 1)
	failures = 1
	shellCalls := 0
	w.beforeShell = func() error {
		shellCalls++
		if failures > 0 {
			failures--
			return errors.New("isolated injected AddTab failure")
		}
		return nil
	}
	if err := w.restore(window); err == nil {
		t.Fatal("shell restore failure ignored")
	}
	actual, _, _ := getWindowLong.Call(window.hwnd, gwlExStyle)
	if uint32(actual)&toolBits != f.windows[1].style&toolBits {
		t.Fatal("style did not restore before shell failure")
	}
	if _, pending := property(window.hwnd, taskbarProperty); !pending {
		t.Fatal("taskbar retry marker lost")
	}
	if _, pending := property(window.hwnd, affinityProperty); pending {
		t.Fatal("shell failure prevented independent capture restore")
	}
	value, err := readAffinity(window.hwnd)
	if err != nil || value != f.windows[1].affinity {
		t.Fatal("capture failed to restore independently", value, err)
	}
	if err = w.restore(window); err != nil {
		t.Fatal(err)
	}
	if shellCalls != 2 {
		t.Fatalf("native-style success suppressed shell retry: %d calls", shellCalls)
	}
	if _, pending := property(window.hwnd, taskbarProperty); pending {
		t.Fatal("successful shell retry retained marker")
	}
}
func TestCaptureRestoreFailureStillRestoresTaskbar(t *testing.T) {
	f := failureFixture(t, "x64")
	w := makeFixtureWorker(t, f)
	if s := w.tick(true); s.State != "active" {
		t.Fatal(s)
	}
	window := fixtureNativeWindow(t, f, 1)
	// Deliberately invalid fixture restore target exercises the real audited
	// helper's rejection. It does not substitute a successful native operation.
	if err := remember(window.hwnd, restoreProperty, 255); err != nil {
		t.Fatal(err)
	}
	if err := w.restore(window); err == nil {
		t.Fatal("invalid capture restore target accepted")
	}
	actual, _, _ := getWindowLong.Call(window.hwnd, gwlExStyle)
	if uint32(actual)&toolBits != f.windows[1].style&toolBits {
		t.Fatal("capture failure prevented taskbar restore")
	}
	if _, pending := property(window.hwnd, taskbarProperty); pending {
		t.Fatal("taskbar marker retained despite successful independent restoration")
	}
	if _, pending := property(window.hwnd, affinityProperty); !pending {
		t.Fatal("failed capture restore lost original")
	}
	forget(window.hwnd, restoreProperty)
	if err := w.restore(window); err != nil {
		t.Fatal("capture retry failed", err)
	}
	value, err := readAffinity(window.hwnd)
	if err != nil || value != f.windows[1].affinity {
		t.Fatal("capture retry readback", value, err)
	}
}
func TestHungFixtureDoesNotBlockOtherArchitecture(t *testing.T) {
	a := failureFixture(t, "x86")
	b := failureFixture(t, "x64")
	w := makeFixtureWorker(t, a, b)
	a.command(t, "hang")
	start := time.Now()
	status := w.tick(true)
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatalf("hung target blocked scan excessively: %v", time.Since(start))
	}
	if status.State != "partial" {
		t.Fatalf("hung target not reported: %+v", status)
	}
	for _, window := range b.windows {
		v, err := readAffinity(window.hwnd)
		if err != nil || v != 17 {
			t.Fatalf("healthy architecture starved: %d %v", v, err)
		}
	}
	// Command acknowledgement waits for the fixture's own 2s pause to end, no
	// polling/synthetic input and no interaction with an installed meeting app.
	a.command(t, "rename")
	if s := w.tick(true); s.State != "active" {
		t.Fatalf("resumed fixture did not repair: %+v", s)
	}
	a.command(t, "hang")
	restored := w.tick(false)
	if restored.State != "restoring" {
		t.Fatalf("hung restoration falsely reported complete: %+v", restored)
	}
	for _, window := range b.windows {
		v, err := readAffinity(window.hwnd)
		if err != nil || v != window.affinity {
			t.Fatalf("healthy architecture restore blocked: %d %v", v, err)
		}
	}
	a.command(t, "rename")
	if s := w.tick(false); s.State != "disabled" {
		t.Fatalf("restore retry failed: %+v", s)
	}
}
func TestCloseRetainsTerminalFailureAndDurableSignal(t *testing.T) {
	m := &MeetingMonitor{stop: make(chan struct{}), done: make(chan struct{}), status: MeetingStatus{State: "restoring", Error: "isolated terminal restore failure"}}
	close(m.done)
	for i := 0; i < 2; i++ {
		if err := m.Close(); err == nil || err.Error() != m.status.Error {
			t.Fatalf("Close %d lost terminal error: %v", i, err)
		}
	}
	select {
	case <-m.stop:
	default:
		t.Fatal("stop request was not durable")
	}
}
func TestCloseWhileFixtureHungRestoresBeforeCompleting(t *testing.T) {
	f := failureFixture(t, "x64")
	m, err := NewMeetingMonitor(MeetingOptions{CacheDir: t.TempDir(), Assets: DefaultHelperAssets, TestProcessIDs: []uint32{uint32(f.cmd.Process.Pid)}})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if s, err := m.Enable(true); err != nil || s.State != "active" {
		t.Fatal(s, err)
	}
	f.command(t, "hang")
	start := time.Now()
	if err = m.Close(); err != nil {
		t.Fatal("recoverable hung shutdown failed", err)
	}
	if elapsed := time.Since(start); elapsed < time.Second || elapsed > 8*time.Second {
		t.Fatalf("shutdown completed without waiting or exceeded bound: %v", elapsed)
	}
	for _, window := range f.windows {
		v, e := readAffinity(window.hwnd)
		if e != nil || v != window.affinity {
			t.Fatalf("shutdown did not restore %#x: %d %v", window.hwnd, v, e)
		}
	}
	if err = m.Close(); err != nil {
		t.Fatal("successful repeated shutdown", err)
	}
	if _, err = m.Enable(true); err == nil {
		t.Fatal("closed monitor restarted")
	}
}
