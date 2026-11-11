//go:build windows && mygo_smoke

package nativewin

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
	"golang.org/x/sys/windows"
)

// Unlike WebView.CapturePage this includes native HWND/DWM chrome. The HWND is
// verified as owned; PrintWindow never reads the desktop or other applications.
func captureCaptionWindow(hwnd uintptr, width, height int) (*image.NRGBA, error) {
	var pid uint32
	getWindowThread.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	if pid != windows.GetCurrentProcessId() {
		return nil, fmt.Errorf("unowned caption capture target")
	}
	gdi := transparencyGDI
	dc, _, err := gdi.NewProc("CreateCompatibleDC").Call(0)
	if dc == 0 {
		return nil, err
	}
	defer gdi.NewProc("DeleteDC").Call(dc)
	type bitmapInfo struct {
		Size                   uint32
		Width, Height          int32
		Planes, Bits           uint16
		Compression, SizeImage uint32
		XPels, YPels           int32
		Used, Important        uint32
	}
	info := bitmapInfo{Size: 40, Width: int32(width), Height: -int32(height), Planes: 1, Bits: 32}
	var bits uintptr
	bmp, _, err := gdi.NewProc("CreateDIBSection").Call(dc, uintptr(unsafe.Pointer(&info)), 0, uintptr(unsafe.Pointer(&bits)), 0, 0)
	if bmp == 0 {
		return nil, err
	}
	defer gdi.NewProc("DeleteObject").Call(bmp)
	old, _, _ := gdi.NewProc("SelectObject").Call(dc, bmp)
	defer gdi.NewProc("SelectObject").Call(dc, old)
	if r, _, e := user32.NewProc("PrintWindow").Call(hwnd, dc, 2); r == 0 {
		return nil, e
	}
	gdi.NewProc("GdiFlush").Call()
	raw := unsafe.Slice((*byte)(unsafe.Pointer(bits)), width*height*4)
	img := image.NewNRGBA(image.Rect(0, 0, width, height))
	for i := 0; i < len(raw); i += 4 {
		img.Pix[i] = raw[i+2]
		img.Pix[i+1] = raw[i+1]
		img.Pix[i+2] = raw[i]
		img.Pix[i+3] = 255
	}
	return img, nil
}

func nativeCaptionProbe(t *testing.T, w *mygo.Window, nw *Window, label string) {
	t.Helper()
	foreground, _, _ := user32.NewProc("GetForegroundWindow").Call()
	var original StealthState
	smokeOnMain(t, func() error {
		var err error
		original, err = nw.State()
		if err != nil {
			return err
		}
		s := original
		s.ScreenCaptureProtection = false
		_, err = nw.SetStealth(s)
		return err
	})
	defer smokeOnMain(t, func() error { _, err := nw.SetStealth(original); return err })
	var bounds rect
	getWindowRect.Call(w.NativeHandle(), uintptr(unsafe.Pointer(&bounds)))
	capture := func(name string) *image.NRGBA {
		t.Helper()
		transparencyDWM.NewProc("DwmFlush").Call()
		time.Sleep(100 * time.Millisecond)
		var img *image.NRGBA
		smokeOnMain(t, func() error {
			var err error
			img, err = captureCaptionWindow(w.NativeHandle(), int(bounds.Right-bounds.Left), int(bounds.Bottom-bounds.Top))
			return err
		})
		f, err := os.Create(filepath.Join(smokeRoot, name+"-"+label+".png"))
		if err != nil {
			t.Fatal(err)
		}
		err = png.Encode(f, img)
		closeErr := f.Close()
		if err != nil {
			t.Fatal(err)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		return img
	}
	// Reproduce the exact former host combination only on this isolated HWND.
	smokeOnMain(t, func() error {
		nw.options.CustomWindowControls = false
		s, _, _ := getWindowLong.Call(nw.hwnd, gwlStyle)
		setWindowLong.Call(nw.hwnd, gwlStyle, s|uintptr(wsSysMenu))
		setWindowPos.Call(nw.hwnd, 0, 0, 0, 0, 0, 1|2|4|0x10|0x20)
		return nil
	})
	before := capture("caption-native-overlap-before")
	smokeOnMain(t, func() error { nw.options.CustomWindowControls = true; return nw.apply() })
	after := capture("caption-custom-only-after")
	changes := 0
	for y := 0; y < 40; y++ {
		for x := after.Bounds().Dx() - 100; x < after.Bounds().Dx(); x++ {
			if before.At(x, y) != after.At(x, y) {
				changes++
			}
		}
	}
	t.Logf("owned native top-right before/after changed pixels=%d; captures include HWND chrome, not just HTML", changes)
	if changes == 0 {
		t.Error("native caption removal did not change the owned HWND top-right pixels")
	}
	if count := smokeEval(t, w, "document.querySelectorAll('.client-title-close').length"); count != float64(1) {
		t.Fatalf("HTML close button count=%v", count)
	}
	smokeOnMain(t, func() error {
		for _, hidden := range []bool{false, true} {
			s := original
			s.HideFromTaskbar = hidden
			if _, err := nw.SetStealth(s); err != nil {
				return err
			}
			for _, pin := range []bool{true, false} {
				if err := nw.SetPinned(pin); err != nil {
					return err
				}
				style, _, _ := getWindowLong.Call(nw.hwnd, gwlStyle)
				if style&uintptr(wsSysMenu) != 0 {
					return fmt.Errorf("system menu restored by taskbar/pin transition")
				}
			}
		}
		// Exercise a framework-style complete rewrite and preserve an unrelated bit.
		style, _, _ := getWindowLong.Call(nw.hwnd, gwlStyle)
		setWindowLong.Call(nw.hwnd, gwlStyle, style|uintptr(wsSysMenu)|0x02000000)
		got, _, _ := getWindowLong.Call(nw.hwnd, gwlStyle)
		if got&uintptr(wsSysMenu) != 0 || got&0x02000000 == 0 {
			return fmt.Errorf("normal-style ownership failed %#x", got)
		}
		showWindow.Call(nw.hwnd, 0)
		showWindow.Call(nw.hwnd, 4)
		_, err := nw.SetStealth(original)
		return err
	})
	// Read-only native hit tests along the former tool-window close-control area.
	smokeOnMain(t, func() error {
		for y := int32(4); y < 30; y += 4 {
			for dx := int32(4); dx < 48; dx += 4 {
				x := bounds.Right - dx
				yy := bounds.Top + y
				packed := uintptr(uint16(x)) | uintptr(uint16(yy))<<16
				hit, _, _ := user32.NewProc("SendMessageW").Call(nw.hwnd, 0x84, 0, packed)
				if hit == 20 {
					return fmt.Errorf("native HTCLOSE remains at right-%d,y%d", dx, y)
				}
			}
		}
		return nil
	})
	now, _, _ := user32.NewProc("GetForegroundWindow").Call()
	if now != foreground && ownsWindow(now) {
		t.Fatal("caption fixture foreground changed during read-only style checks")
	}
}
