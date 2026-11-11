//go:build windows

package nativewin

import (
	"errors"
	"golang.org/x/sys/windows"
	"sync"
	"unsafe"
)

type workAreaScan struct {
	bounds rect
	found  bool
	err    error
}

var workAreaScans sync.Map
var monitorCallback = windows.NewCallback(func(mon, dc, area, data uintptr) uintptr {
	value, ok := workAreaScans.Load(data)
	if !ok {
		return 0
	}
	s := value.(*workAreaScan)
	mi := monitorInfo{}
	mi.Size = uint32(unsafe.Sizeof(mi))
	r, _, e := getMonitorInfo.Call(mon, uintptr(unsafe.Pointer(&mi)))
	if err := apiError("GetMonitorInfo", r, e); err != nil {
		s.err = err
		return 0
	}
	if !s.found {
		s.bounds = mi.Work
		s.found = true
	} else {
		s.bounds.Left = min(s.bounds.Left, mi.Work.Left)
		s.bounds.Top = min(s.bounds.Top, mi.Work.Top)
		s.bounds.Right = max(s.bounds.Right, mi.Work.Right)
		s.bounds.Bottom = max(s.bounds.Bottom, mi.Work.Bottom)
	}
	return 1
})

func unionWorkArea() (rect, error) {
	id := uintptr(windows.GetCurrentThreadId())
	s := &workAreaScan{}
	workAreaScans.Store(id, s)
	defer workAreaScans.Delete(id)
	r, _, e := enumMonitors.Call(0, 0, monitorCallback, id)
	if s.err != nil {
		return rect{}, s.err
	}
	if err := apiError("EnumDisplayMonitors", r, e); err != nil {
		return rect{}, err
	}
	if !s.found {
		return rect{}, errors.New("no display work areas available")
	}
	return s.bounds, nil
}
