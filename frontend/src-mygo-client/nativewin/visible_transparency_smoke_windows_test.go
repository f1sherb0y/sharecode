//go:build windows && mygo_smoke

package nativewin

import (
	"bytes"
	"fmt"
	"image/color"
	"image/png"
	"math"
	"testing"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
	"golang.org/x/sys/windows"
)

var transparencyDWM = windows.NewLazySystemDLL("dwmapi.dll")
var transparencyGDI = windows.NewLazySystemDLL("gdi32.dll")

// visibleFrontendComposition reads a few composed pixels only where a complete
// opaque, owned test backdrop is present. It never screenshots the desktop or
// saves pixels from another application, and never injects input or takes focus.
func visibleFrontendComposition(t *testing.T, w *mygo.Window, nw *Window) {
	t.Helper()
	foreground, _, _ := user32.NewProc("GetForegroundWindow").Call()
	var backdrop uintptr
	mode := 0
	var original StealthState
	var pinned bool
	var clientOrigin struct{ X, Y int32 }
	var backdropRect rect
	var brushes [2]uintptr
	smokeOnMain(t, func() error {
		var err error
		original, err = nw.State()
		if err != nil {
			return err
		}
		pinned, err = nw.IsPinned()
		if err != nil {
			return err
		}
		brushes[0], _, _ = transparencyGDI.NewProc("CreateSolidBrush").Call(0xffffff)
		brushes[1], _, _ = transparencyGDI.NewProc("CreateSolidBrush").Call(0x202020)
		callback := windows.NewCallback(func(hwnd, msg, wp, lp uintptr) uintptr {
			if msg == 0x14 {
				var area rect
				user32.NewProc("GetClientRect").Call(hwnd, uintptr(unsafe.Pointer(&area)))
				if mode < 2 {
					user32.NewProc("FillRect").Call(wp, uintptr(unsafe.Pointer(&area)), brushes[mode])
				} else {
					for y := int32(0); y < area.Bottom; y += 32 {
						for x := int32(0); x < area.Right; x += 32 {
							tile := rect{x, y, min(x+32, area.Right), min(y+32, area.Bottom)}
							user32.NewProc("FillRect").Call(wp, uintptr(unsafe.Pointer(&tile)), brushes[(x/32+y/32)%2])
						}
					}
				}
				return 1
			}
			r, _, _ := user32.NewProc("DefWindowProcW").Call(hwnd, msg, wp, lp)
			return r
		})
		name := windows.StringToUTF16Ptr(fmt.Sprintf("ShareCodeOwnedAlphaBackdrop-%d", time.Now().UnixNano()))
		module, _, _ := windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW").Call(0)
		type windowClass struct {
			Size, Style                        uint32
			Proc                               uintptr
			ClassExtra, WindowExtra            int32
			Instance, Icon, Cursor, Background uintptr
			Menu, Name                         *uint16
			SmallIcon                          uintptr
		}
		class := windowClass{Proc: callback, Instance: module, Background: brushes[0], Name: name}
		class.Size = uint32(unsafe.Sizeof(class))
		if r, _, e := user32.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class))); r == 0 {
			return e
		}
		monitor, _, _ := user32.NewProc("MonitorFromPoint").Call(0, 1)
		mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
		if r, _, e := getMonitorInfo.Call(monitor, uintptr(unsafe.Pointer(&mi))); r == 0 {
			return e
		}
		left, top := mi.Work.Left+20, mi.Work.Top+20
		backdropRect = rect{left, top, left + 800, top + 720}
		backdrop, _, err = user32.NewProc("CreateWindowExW").Call(0x08000080, uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(name)), 0x80000000, uintptr(left), uintptr(top), 800, 720, 0, 0, module, 0)
		if backdrop == 0 {
			return err
		}
		_, err = nw.SetStealth(StealthState{HideFromTaskbar: true})
		if err != nil {
			return err
		}
		if err = nw.SetPinned(true); err != nil {
			return err
		}
		setWindowPos.Call(backdrop, ^uintptr(0), uintptr(left), uintptr(top), 800, 720, 0x10|0x40)
		setWindowPos.Call(w.NativeHandle(), ^uintptr(0), uintptr(left+12), uintptr(top+12), 760, 680, 0x10|0x40)
		user32.NewProc("ClientToScreen").Call(w.NativeHandle(), uintptr(unsafe.Pointer(&clientOrigin)))
		return nil
	})
	defer smokeOnMain(t, func() error {
		setWindowPos.Call(w.NativeHandle(), 0, 23000, 23000, 760, 680, 4|0x10)
		_, err := nw.SetStealth(original)
		if err != nil {
			return err
		}
		if err = nw.SetPinned(pinned); err != nil {
			return err
		}
		user32.NewProc("DestroyWindow").Call(backdrop)
		for _, b := range brushes {
			transparencyGDI.NewProc("DeleteObject").Call(b)
		}
		return nil
	})
	points := [][2]int32{{20, 100}, {60, 100}, {100, 100}}
	read := func(expectedRoot uintptr) []color.NRGBA {
		t.Helper()
		result := make([]color.NRGBA, len(points))
		dc, _, _ := user32.NewProc("GetDC").Call(0)
		defer user32.NewProc("ReleaseDC").Call(0, dc)
		for i, p := range points {
			x, y := clientOrigin.X+p[0], clientOrigin.Y+p[1]
			if x < backdropRect.Left || x >= backdropRect.Right || y < backdropRect.Top || y >= backdropRect.Bottom {
				t.Fatal("refusing to sample outside owned opaque backdrop")
			}
			packed := uintptr(uint64(uint32(x)) | uint64(uint32(y))<<32)
			hit, _, _ := user32.NewProc("WindowFromPoint").Call(packed)
			root, _, _ := user32.NewProc("GetAncestor").Call(hit, 2)
			if root != expectedRoot {
				t.Fatalf("owned sample occluded: root %#x expected %#x; no pixel read", root, expectedRoot)
			}
			value, _, _ := transparencyGDI.NewProc("GetPixel").Call(dc, uintptr(x), uintptr(y))
			again, _, _ := user32.NewProc("WindowFromPoint").Call(packed)
			again, _, _ = user32.NewProc("GetAncestor").Call(again, 2)
			if again != expectedRoot {
				t.Fatal("sample ownership changed; discarding pixel")
			}
			if uint32(value) == 0xffffffff {
				t.Fatal("GetPixel failed")
			}
			result[i] = color.NRGBA{uint8(value), uint8(value >> 8), uint8(value >> 16), 255}
		}
		return result
	}
	originalAlpha := smokeEval(t, w, "document.body.style.getPropertyValue('--client-bg-alpha')").(string)
	defer smokeEval(t, w, fmt.Sprintf("document.body.style.setProperty('--client-bg-alpha',%q)", originalAlpha))
	for _, phase := range []struct {
		alpha        string
		clickThrough bool
	}{{"0.65", false}, {"0.1", true}, {"0.65", false}} {
		alpha := phase.alpha
		smokeOnMain(t, func() error {
			// Native style primitive only: never register a listener or fake its health.
			nw.desired.ClickThrough = phase.clickThrough
			if err := nw.apply(); err != nil {
				return err
			}
			style, _, _ := getWindowLong.Call(nw.hwnd, gwlExStyle)
			if style&0x00200000 == 0 {
				return fmt.Errorf("native surface lost lifetime WS_EX_NOREDIRECTIONBITMAP")
			}
			return nil
		})
		smokeEval(t, w, fmt.Sprintf("document.body.style.setProperty('--client-bg-alpha',%q)", alpha))
		time.Sleep(100 * time.Millisecond)
		data, err := captureForSmoke(w)
		if err != nil {
			t.Fatal(err)
		}
		page, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		for backdropMode := 0; backdropMode < 3; backdropMode++ {
			smokeOnMain(t, func() error {
				mode = backdropMode
				showWindow.Call(w.NativeHandle(), 0)
				user32.NewProc("InvalidateRect").Call(backdrop, 0, 1)
				user32.NewProc("UpdateWindow").Call(backdrop)
				return nil
			})
			transparencyDWM.NewProc("DwmFlush").Call()
			time.Sleep(80 * time.Millisecond)
			background := read(backdrop)
			smokeOnMain(t, func() error {
				showWindow.Call(w.NativeHandle(), 4)
				setWindowPos.Call(w.NativeHandle(), ^uintptr(0), 0, 0, 0, 0, 1|2|0x10)
				return nil
			})
			transparencyDWM.NewProc("DwmFlush").Call()
			time.Sleep(100 * time.Millisecond)
			ownerAtPoint := w.NativeHandle()
			if phase.clickThrough {
				ownerAtPoint = backdrop
			}
			composed := read(ownerAtPoint)
			for i, p := range points {
				pixel := color.NRGBAModel.Convert(page.At(int(p[0]), int(p[1]))).(color.NRGBA)
				blend := func(fg, bg uint8) uint8 {
					return uint8(math.Round(float64(fg)*float64(pixel.A)/255 + float64(bg)*(255-float64(pixel.A))/255))
				}
				want := color.NRGBA{blend(pixel.R, background[i].R), blend(pixel.G, background[i].G), blend(pixel.B, background[i].B), 255}
				delta := func(a, b uint8) int {
					v := int(a) - int(b)
					if v < 0 {
						return -v
					}
					return v
				}
				t.Logf("visible actual frontend alpha=%s backdrop=%d point=%v page=%v background=%v screen=%v want=%v", alpha, mode, p, pixel, background[i], composed[i], want)
				if delta(composed[i].R, want.R) > 3 || delta(composed[i].G, want.G) > 3 || delta(composed[i].B, want.B) > 3 {
					t.Errorf("visible composition does not match independent page/background alpha")
				}
			}
		}
	}
	after, _, _ := user32.NewProc("GetForegroundWindow").Call()
	if after != foreground && ownsWindow(after) {
		t.Fatal("visible fixture changed foreground")
	}
}
