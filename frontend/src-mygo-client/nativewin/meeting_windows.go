//go:build windows

package nativewin

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

var affinityProperty = windows.StringToUTF16Ptr("ShareCode.MeetingPrivacy.Affinity.v1")
var restoreProperty = windows.StringToUTF16Ptr("ShareCode.MeetingPrivacy.RestoreAffinity.v1")
var taskbarProperty = windows.StringToUTF16Ptr("ShareCode.MeetingPrivacy.Taskbar.v1")
var mainImages = []string{"wemeetapp.exe", "voovmeeting.exe", "voovmeetingapp.exe"}

func meetingImage(path string) bool {
	name := strings.ToLower(filepath.Base(path))
	for _, main := range mainImages {
		if name == main || name == strings.TrimSuffix(main, ".exe")+"_new.exe" {
			return true
		}
	}
	dir := filepath.Dir(path)
	for i := 0; i < 4; i++ {
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		for _, main := range mainImages {
			if info, err := os.Stat(filepath.Join(dir, main)); err == nil && !info.IsDir() {
				return true
			}
		}
		dir = parent
	}
	return false
}
func meetingProcess(pid uint32) bool {
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(p)
	buf := make([]uint16, 32768)
	n := uint32(len(buf))
	if windows.QueryFullProcessImageName(p, 0, &buf[0], &n) != nil {
		return false
	}
	return meetingImage(windows.UTF16ToString(buf[:n]))
}

type meetingWindow struct {
	hwnd               uintptr
	pid, thread, style uint32
	visible            bool
}

func (w meetingWindow) current() bool {
	var pid uint32
	t, _, _ := getWindowThread.Call(w.hwnd, uintptr(unsafe.Pointer(&pid)))
	return t != 0 && uint32(t) == w.thread && pid == w.pid
}
func readAffinity(hwnd uintptr) (uint32, error) {
	var v uint32
	r, _, e := getAffinity.Call(hwnd, uintptr(unsafe.Pointer(&v)))
	return v, apiError("GetWindowDisplayAffinity", r, e)
}
func property(hwnd uintptr, name *uint16) (uint32, bool) {
	r, _, _ := getProp.Call(hwnd, uintptr(unsafe.Pointer(name)))
	return uint32(r - 1), r != 0
}
func remember(hwnd uintptr, name *uint16, value uint32) error {
	if _, ok := property(hwnd, name); ok {
		return nil
	}
	r, _, e := setProp.Call(hwnd, uintptr(unsafe.Pointer(name)), uintptr(value)+1)
	return apiError("SetProp", r, e)
}
func forget(hwnd uintptr, name *uint16) { removeProp.Call(hwnd, uintptr(unsafe.Pointer(name))) }

type meetingCommand struct {
	enabled bool
	answer  chan MeetingStatus
}
type MeetingMonitor struct {
	options  MeetingOptions
	commands chan meetingCommand
	stop     chan struct{}
	done     chan struct{}
	mu       sync.RWMutex
	status   MeetingStatus
	closed   atomic.Bool
}

func NewMeetingMonitor(o MeetingOptions) (*MeetingMonitor, error) {
	if o.CacheDir == "" {
		return nil, errors.New("meeting helper cache directory required")
	}
	if !o.Assets.complete() {
		o.Assets = DefaultHelperAssets
	}
	m := &MeetingMonitor{options: o, commands: make(chan meetingCommand), stop: make(chan struct{}), done: make(chan struct{}), status: MeetingStatus{State: "disabled"}}
	go m.run()
	return m, nil
}
func (m *MeetingMonitor) Status() MeetingStatus { m.mu.RLock(); defer m.mu.RUnlock(); return m.status }
func (m *MeetingMonitor) Enable(v bool) (MeetingStatus, error) {
	if m.closed.Load() {
		return m.Status(), errors.New("meeting monitor closed")
	}
	if v && !m.options.Assets.complete() {
		return m.Status(), errors.New("meeting privacy unavailable: architecture-matched helpers were not built")
	}
	c := meetingCommand{enabled: v, answer: make(chan MeetingStatus, 1)}
	select {
	case m.commands <- c:
	case <-m.done:
		return m.Status(), errors.New("meeting monitor stopped")
	}
	select {
	case s := <-c.answer:
		if s.Error != "" {
			return s, errors.New(s.Error)
		}
		return s, nil
	case <-m.done:
		return m.Status(), errors.New("meeting monitor stopped")
	}
}
func (m *MeetingMonitor) Close() error {
	// Closing the channel cannot be lost when a scan is busy. Every caller waits
	// for the same terminal result; a late call never converts failure to success.
	if !m.closed.Swap(true) {
		close(m.stop)
	}
	timer := time.NewTimer(8 * time.Second)
	defer timer.Stop()
	select {
	case <-m.done:
		if s := m.Status(); s.Error != "" {
			return errors.New(s.Error)
		}
		return nil
	case <-timer.C:
		return errors.New("meeting windows could not all be restored before shutdown deadline; worker is still restoring")
	}
}
func (m *MeetingMonitor) publish(s MeetingStatus) {
	m.mu.Lock()
	changed := m.status != s
	m.status = s
	m.mu.Unlock()
	if changed && m.options.OnStatus != nil {
		m.options.OnStatus(s)
	}
}

type meetingWorker struct {
	monitor *MeetingMonitor
	bridge  meetingBridge
	mutex   windows.Handle
	shell   uintptr
	dirty   atomic.Bool
	// Tests may inject a shell failure, but never replace successful native work.
	beforeShell func() error
}

// Process-local callback registry prevents callback thunk leaks on each scan.
var enumerationWorkers sync.Map
var enumCallback = windows.NewCallback(func(hwnd, data uintptr) uintptr {
	value, ok := enumerationWorkers.Load(data)
	if !ok {
		return 0
	}
	s := value.(*meetingSnapshot)
	var pid uint32
	thread, _, _ := getWindowThread.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if s.allowed != nil && !s.allowed[pid] {
		return 1
	}
	yes, known := s.processes[pid]
	if !known {
		yes = meetingProcess(pid)
		s.processes[pid] = yes
	}
	if yes {
		s.windows = append(s.windows, meetingWindow{hwnd, pid, uint32(thread), exStyle(hwnd), visible(hwnd)})
	}
	return 1
})
var scanID atomic.Uint64

type meetingSnapshot struct {
	windows   []meetingWindow
	processes map[uint32]bool
	allowed   map[uint32]bool
}

func (w *meetingWorker) snapshot() ([]meetingWindow, error) {
	s := &meetingSnapshot{processes: map[uint32]bool{}}
	if w.monitor.options.TestProcessIDs != nil {
		s.allowed = map[uint32]bool{}
		for _, pid := range w.monitor.options.TestProcessIDs {
			s.allowed[pid] = true
		}
	}
	id := uintptr(scanID.Add(1))
	enumerationWorkers.Store(id, s)
	defer enumerationWorkers.Delete(id)
	r, _, e := enumWindows.Call(enumCallback, id)
	return s.windows, apiError("EnumWindows", r, e)
}

var eventWorkers sync.Map // keyed by dedicated thread ID
var eventCallback = windows.NewCallback(func(hook, event, hwnd, object, child, thread, time uintptr) uintptr {
	if object == 0 && child == 0 && hwnd != 0 {
		if v, ok := eventWorkers.Load(windows.GetCurrentThreadId()); ok {
			v.(*meetingWorker).dirty.Store(true)
		}
	}
	return 0
})

func (m *MeetingMonitor) run() {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(m.done)
	hr, _, _ := coInitializeEx.Call(0, coinitApartmentThreaded)
	if int32(hr) >= 0 {
		defer coUninitialize.Call()
	}
	w := meetingWorker{monitor: m, bridge: meetingBridge{dir: m.options.CacheDir, assets: m.options.Assets, hosts: map[uint16]*helperHost{}}}
	defer w.bridge.close()
	defer func() {
		if w.mutex != 0 {
			windows.ReleaseMutex(w.mutex)
			windows.CloseHandle(w.mutex)
		}
		if w.shell != 0 {
			comCall(w.shell, taskbarRelease)
		}
	}()
	tid := windows.GetCurrentThreadId()
	eventWorkers.Store(tid, &w)
	defer eventWorkers.Delete(tid)
	var hook uintptr
	defer func() {
		if hook != 0 {
			unhookWinEvent.Call(hook)
		}
	}()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	enabled := false
	last := time.Now()
	var msg winMessage
	finish := func() {
		if hook != 0 {
			unhookWinEvent.Call(hook)
			hook = 0
		}
		deadline := time.Now().Add(5 * time.Second)
		s := w.tick(false)
		m.publish(s)
		for s.State == "restoring" && time.Now().Before(deadline) {
			// Failed permissions must not become a hot loop during shutdown.
			timer := time.NewTimer(100 * time.Millisecond)
			<-timer.C
			s = w.tick(false)
		}
		m.publish(s)
	}
	for {
		if m.closed.Load() {
			finish()
			return
		}
		select {
		case <-m.stop:
			finish()
			return
		case c := <-m.commands:
			if m.closed.Load() {
				s := m.Status()
				s.Error = "meeting monitor is closing"
				c.answer <- s
				continue
			}
			enabled = c.enabled
			if enabled && hook == 0 {
				hook, _, _ = setWinEventHook.Call(eventObjectCreate, eventObjectHide, 0, eventCallback, 0, 0, 0)
			} else if !enabled && hook != 0 {
				unhookWinEvent.Call(hook)
				hook = 0
			}
			s := w.tick(enabled)
			if enabled && hook == 0 {
				s.State = "partial"
				s.Error = "Window event observer unavailable"
			}
			m.publish(s)
			last = time.Now()
			c.answer <- s
		case <-ticker.C:
			for {
				r, _, _ := peekMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0, pmRemove)
				if r == 0 {
					break
				}
				translateMessage.Call(uintptr(unsafe.Pointer(&msg)))
				dispatchMessage.Call(uintptr(unsafe.Pointer(&msg)))
			}
			if (enabled || m.Status().State == "restoring") && (w.dirty.Swap(false) || time.Since(last) >= time.Second) {
				s := w.tick(enabled)
				if enabled && hook == 0 {
					s.State = "partial"
					s.Error = "Window event observer unavailable"
				}
				m.publish(s)
				last = time.Now()
			}
		}
	}
}
func (w *meetingWorker) ownership() error {
	if w.mutex != 0 {
		return nil
	}
	name := "Local\\ShareCode.MeetingPrivacy.v1"
	if w.monitor.options.TestProcessIDs != nil {
		name = fmt.Sprintf("Local\\ShareCode.MeetingPrivacy.MyGo.Test.%d", os.Getpid())
	}
	h, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
	if err != nil && err != windows.ERROR_ALREADY_EXISTS {
		return err
	}
	v, err := windows.WaitForSingleObject(h, 0)
	if err != nil || (v != windows.WAIT_OBJECT_0 && v != windows.WAIT_ABANDONED) {
		windows.CloseHandle(h)
		return errors.New("another ShareCode instance manages meeting windows")
	}
	w.mutex = h
	return nil
}
func (w *meetingWorker) tick(enabled bool) MeetingStatus {
	s := MeetingStatus{Enabled: enabled, State: "disabled"}
	fail := func(err error) {
		if err != nil && s.Error == "" {
			s.Error = err.Error()
		}
	}
	if err := w.ownership(); err != nil {
		fail(err)
	} else {
		list, err := w.snapshot()
		fail(err)
		pids := map[uint32]bool{}
		blocked := map[[2]uint32]error{}
		deadline := time.Now().Add(2 * time.Second)
		for _, window := range list {
			pids[window.pid] = true
			if enabled && w.monitor.closed.Load() {
				fail(errors.New("meeting monitor is stopping"))
				break
			}
			if time.Now().After(deadline) {
				fail(errors.New("meeting scan exceeded time budget; remaining windows will retry"))
				break
			}
			if !window.current() {
				continue
			}
			key := [2]uint32{window.pid, window.thread}
			if err := blocked[key]; err != nil {
				if window.visible || !enabled {
					fail(err)
				}
				continue
			}
			var err error
			if !enabled {
				err = w.restore(window)
			} else {
				value, captureErr := readAffinity(window.hwnd)
				if captureErr == nil {
					captureErr = remember(window.hwnd, affinityProperty, value)
					forget(window.hwnd, restoreProperty)
				}
				owner, _, _ := getWindow.Call(window.hwnd, gwOwner)
				_, managed := property(window.hwnd, taskbarProperty)
				// Windows with a taskbar button: APPWINDOW, or unowned and not a tool window.
				if managed || (window.visible && (window.style&wsExAppWindow != 0 || (window.style&wsExToolWindow == 0 && owner == 0))) {
					err = remember(window.hwnd, taskbarProperty, window.style&toolBits)
					if err == nil {
						err = w.taskbar(window, true, wsExToolWindow)
					}
					if err == nil {
						s.HiddenTaskbarWindows++
					}
				}
				// Independent paths: taskbar errors cannot suppress capture protection.
				if captureErr == nil {
					actual, e := readAffinity(window.hwnd)
					captureErr = e
					if e == nil && actual != wdaExcludeFromCapture {
						captureErr = w.bridge.apply(window, helperAffinity, wdaExcludeFromCapture)
					}
				}
				if captureErr == nil && window.visible {
					s.ProtectedWindows++
				}
				if err == nil {
					err = captureErr
				}
			}
			if err != nil && window.current() {
				// Only an unresponsive target warrants skipping its other HWNDs.
				// A shell/property error on one HWND must not starve sibling windows.
				if errors.Is(err, errMeetingThreadBlocked) {
					blocked[key] = err
				}
				if window.visible || !enabled {
					fail(err)
				}
			}
		}
		s.MeetingProcesses = len(pids)
	}
	if s.Error != "" {
		if enabled {
			s.State = "partial"
		} else {
			s.State = "restoring"
		}
	} else if enabled {
		if s.MeetingProcesses == 0 {
			s.State = "waiting"
		} else {
			s.State = "active"
		}
	} else {
		w.bridge.close()
		if w.mutex != 0 {
			windows.ReleaseMutex(w.mutex)
			windows.CloseHandle(w.mutex)
			w.mutex = 0
		}
	}
	return s
}
func (w *meetingWorker) restore(window meetingWindow) error {
	target, have := property(window.hwnd, restoreProperty)
	var captureErr error
	if !have {
		if original, ok := property(window.hwnd, affinityProperty); ok {
			actual, e := readAffinity(window.hwnd)
			captureErr = e
			if e == nil {
				target = actual
				if actual == wdaExcludeFromCapture {
					target = original
				}
				captureErr = remember(window.hwnd, restoreProperty, target)
				have = captureErr == nil
			}
		}
	}
	var styleErr error
	if original, ok := property(window.hwnd, taskbarProperty); ok {
		bits := exStyle(window.hwnd) & toolBits
		if bits == wsExToolWindow {
			bits = original
		}
		// A previous attempt may have restored the native style but failed to
		// re-add the Explorer tab. Retry the shell operation before dropping the
		// marker; preserve unrelated/external style changes in the meantime.
		styleErr = w.taskbar(window, false, bits)
		if styleErr == nil {
			forget(window.hwnd, taskbarProperty)
		}
	}
	if have && captureErr == nil {
		actual, e := readAffinity(window.hwnd)
		captureErr = e
		if e == nil && actual != target {
			captureErr = w.bridge.apply(window, helperAffinity, target)
		}
		if captureErr == nil {
			forget(window.hwnd, affinityProperty)
			forget(window.hwnd, restoreProperty)
		}
	}
	return errors.Join(captureErr, styleErr)
}
func (w *meetingWorker) taskbar(window meetingWindow, hide bool, bits uint32) error {
	if !window.current() {
		return errors.New("meeting window changed")
	}
	if exStyle(window.hwnd)&toolBits != bits {
		if err := w.bridge.apply(window, helperTaskbarStyle, bits); err != nil {
			return err
		}
	}
	if w.beforeShell != nil {
		if err := w.beforeShell(); err != nil {
			return err
		}
	}
	if w.shell == 0 {
		hr, _, _ := coCreateInstance.Call(uintptr(unsafe.Pointer(&taskbarListClass)), 0, clsctxInprocServer, uintptr(unsafe.Pointer(&taskbarListIID)), uintptr(unsafe.Pointer(&w.shell)))
		if int32(hr) < 0 {
			return fmt.Errorf("taskbar COM initialization failed: %#x", hr)
		}
		if hr = comCall(w.shell, taskbarHrInit); int32(hr) < 0 {
			comCall(w.shell, taskbarRelease)
			w.shell = 0
			return fmt.Errorf("taskbar initialization failed: %#x", hr)
		}
	}
	index := uintptr(taskbarAddTab)
	if hide {
		index = taskbarDeleteTab
	} else if !window.visible {
		return nil
	}
	hr := comCall(w.shell, index, window.hwnd)
	if int32(hr) < 0 {
		return fmt.Errorf("taskbar update failed: %#x", hr)
	}
	return nil
}
func comCall(object, index uintptr, args ...uintptr) uintptr {
	vtable := *(*uintptr)(unsafe.Pointer(object))
	method := *(*uintptr)(unsafe.Pointer(vtable + index*unsafe.Sizeof(uintptr(0))))
	all := append([]uintptr{object}, args...)
	r, _, _ := syscall.SyscallN(method, all...)
	return r
}
