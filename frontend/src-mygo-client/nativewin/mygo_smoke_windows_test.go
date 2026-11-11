//go:build windows && mygo_smoke

package nativewin

import (
	"bytes"
	"context"
	"fmt"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"github.com/egoist/mygo"
)

const smokeHTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; img-src 'none'"><style>html,body{margin:0;width:100%;height:100%;background:transparent}#tile{position:absolute;left:24px;top:24px;width:120px;height:96px;background:rgb(230,40,80)}#alpha{position:absolute;left:160px;top:24px;width:60px;height:96px;background:rgba(40,100,230,.5)}</style><div id="tile"></div><div id="alpha"></div><script>window.fixtureReady=true</script>`

var smokeRoot string

func TestMain(m *testing.M) {
	if os.Getenv("SHARECODE_MYGO_NATIVE_SMOKE") != "1" {
		fmt.Println("MyGo smoke disabled; set SHARECODE_MYGO_NATIVE_SMOKE=1 with -tags=mygo_smoke")
		os.Exit(0)
	}
	var err error
	smokeRoot, err = os.MkdirTemp("", "sharecode-mygo-native-smoke-")
	if err != nil {
		panic(err)
	}
	fmt.Println("Isolated MyGo smoke profile/artifacts:", smokeRoot)
	if err = os.Setenv("WEBVIEW2_USER_DATA_FOLDER", filepath.Join(smokeRoot, "WebView2")); err != nil {
		panic(err)
	}
	mygo.App.SetName("sharecode-native-smoke-isolated")
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(smokeRoot, "profile"))
	mygo.App.SetMenu(nil)
	// Local custom scheme only. CSP disallows every network connection; no app
	// frontend/updater is loaded and no production profile is consulted.
	if err = mygo.Protocol.Handle("nativefixture", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, smokeHTML)
	})); err != nil {
		panic(err)
	}
	if err = configureFrontendSmoke(); err != nil {
		panic(err)
	}
	mygo.App.OnWindowAllClosed(func() {})
	code := 1
	mygo.App.WhenReady(func() { go func() { code = m.Run(); mygo.App.Quit() }() })
	if err = mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Retain only this newly-created isolated directory as visual test evidence.
	os.Exit(code)
}
func smokeOnMain(t *testing.T, f func() error) {
	t.Helper()
	var err error
	mygo.RunOnMain(func() { err = f() })
	if err != nil {
		t.Fatal(err)
	}
}
func newSmokeWindow(t *testing.T) (*mygo.Window, *Window) {
	t.Helper()
	var mw *mygo.Window
	var nw *Window
	smokeOnMain(t, func() error {
		mw = mygo.NewWindow(mygo.WindowOptions{Title: "ShareCode native smoke (isolated)", URL: "nativefixture://localhost/", Width: 280, Height: 180, Hidden: true, Frameless: true, Transparent: true, BackgroundColor: "#00000000", SkipTaskbar: true, DisableResize: true, Page: mygo.PageOptions{Session: mygo.NewEphemeralSession(), BackgroundThrottling: mygo.ThrottlingOff}})
		hwnd := mw.NativeHandle()
		r, _, e := setWindowPos.Call(hwnd, 0, 20000, 20000, 280, 180, 4|0x10)
		if err := apiError("SetWindowPos fixture offscreen", r, e); err != nil {
			return err
		}
		var err error
		nw, err = Attach(hwnd, Options{Dispatch: mygo.RunOnMain, SetTaskbarHidden: func(v bool) error { mw.SetSkipTaskbar(v); return nil }})
		return err
	})
	t.Cleanup(func() {
		mygo.RunOnMain(func() {
			if nw != nil {
				_ = nw.Close()
			}
			if mw != nil {
				mw.Destroy()
			}
		})
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		value, err := mw.Page().EvalContext(ctx, "window.fixtureReady === true")
		if err == nil && value == true {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("real WebView2 did not initialize: %v / %v", value, err)
		case <-ticker.C:
		}
	}
	smokeOnMain(t, func() error { showWindow.Call(mw.NativeHandle(), 4); return nil })
	return mw, nw
}
func smokeCapture(t *testing.T, w *mygo.Window, name string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// DOM location/DPI map determines the physical pixel sampled in CapturePage.
	v, err := w.Page().EvalContext(ctx, "({dpr:devicePixelRatio, tile:getComputedStyle(document.querySelector('#tile')).backgroundColor, width:innerWidth, height:innerHeight})")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s DOM: %#v", name, v)
	type result struct {
		data []byte
		err  error
	}
	done := make(chan result, 1)
	go func() { b, e := w.CapturePage(); done <- result{b, e} }()
	var data []byte
	select {
	case r := <-done:
		if r.err != nil {
			t.Fatal(r.err)
		}
		data = r.data
	case <-ctx.Done():
		t.Fatal("WebView2 CapturePage timeout")
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	// The fixture is entirely local. This captures WebView2's own rendered page,
	// not the desktop and not another application's pixels.
	if err = os.WriteFile(filepath.Join(smokeRoot, name+".png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	counts := 0
	for y := 0; y < img.Bounds().Dy(); y++ {
		for x := 0; x < img.Bounds().Dx(); x++ {
			r, g, b, a := img.At(x, y).RGBA()
			if r > 50000 && g < 15000 && b < 26000 && a > 60000 {
				counts++
			}
		}
	}
	if counts < 200 {
		t.Fatalf("%s snapshot did not contain rendered red fixture: %d pixels, bounds %v", name, counts, img.Bounds())
	}
	r, g, b, a := img.At(2, 2).RGBA()
	t.Logf("%s: %d red pixels; corner RGBA=%d,%d,%d,%d; PNG %s", name, counts, r, g, b, a, filepath.Join(smokeRoot, name+".png"))
	if a != 0 {
		t.Errorf("%s transparent page corner must retain zero alpha, got %d", name, a)
	}
}
func TestMyGoTransparentWebViewLifecycle(t *testing.T) {
	foreground := user32.NewProc("GetForegroundWindow")
	front, _, _ := foreground.Call()
	mw, nw := newSmokeWindow(t)
	assertFocus := func() {
		t.Helper()
		now, _, _ := foreground.Call()
		if now != front && ownsWindow(now) {
			t.Fatalf("native fixture changed foreground: before %#x after %#x", front, now)
		}
	}
	assertFocus()
	smokeCapture(t, mw, "mygo-before-clickthrough")
	smokeOnMain(t, func() error {
		_, err := nw.SetStealth(StealthState{ClickThrough: true, ScreenCaptureProtection: true, HideFromTaskbar: true})
		if err == nil {
			return fmt.Errorf("public API accepted clickthrough without a listener")
		}
		return nil
	})
	for i := 0; i < 3; i++ {
		smokeOnMain(t, func() error {
			if err := nw.SetPinned(true); err != nil {
				return err
			}
			p, err := nw.IsPinned()
			if err != nil || !p {
				return fmt.Errorf("pin readback: %t %v", p, err)
			}
			// Exercise the actual style/compositor primitive only. No fake listener
			// health, shortcut hook/registration, or public-gate success is claimed.
			nw.desired.ClickThrough = true
			if err = nw.apply(); err != nil {
				return err
			}
			state, err := nw.State()
			if err != nil || !state.ClickThrough {
				return fmt.Errorf("clickthrough readback: %+v %v", state, err)
			}
			send := user32.NewProc("SendMessageW")
			r, _, _ := send.Call(nw.hwnd, 0x21, 0, 0)
			if r != 3 {
				return fmt.Errorf("WM_MOUSEACTIVATE was not MA_NOACTIVATE: %d", r)
			}
			return nil
		})
		assertFocus()
		if i == 0 {
			smokeCapture(t, mw, "mygo-during-clickthrough")
		}
		smokeOnMain(t, func() error {
			nw.desired.ClickThrough = false
			if err := nw.apply(); err != nil {
				return err
			}
			if err := nw.SetPinned(false); err != nil {
				return err
			}
			p, err := nw.IsPinned()
			if err != nil || p {
				return fmt.Errorf("unpin readback: %t %v", p, err)
			}
			return nil
		})
		assertFocus()
	}
	smokeCapture(t, mw, "mygo-after-clickthrough")
	smokeOnMain(t, func() error {
		if _, err := nw.ToggleVisibility(); err != nil {
			return err
		}
		if _, err := nw.ToggleVisibility(); err != nil {
			return err
		}
		return nil
	})
	assertFocus()
	// A pure read-only WindowFromPoint query; never moves the cursor or injects
	// input. Outside the virtual desktop Windows may return no HWND at all.
	var bounds rect
	getWindowRect.Call(nw.hwnd, uintptr(unsafe.Pointer(&bounds)))
	x, y := bounds.Left+60, bounds.Top+60
	point := uintptr(uint32(x)) | uintptr(uint32(y))<<32
	fromPoint := user32.NewProc("WindowFromPoint")
	ancestor := user32.NewProc("GetAncestor")
	at, _, _ := fromPoint.Call(point)
	root, _, _ := ancestor.Call(at, 2)
	if root != nw.hwnd {
		t.Fatalf("offscreen hit-routing baseline is not the fixture: point=%d,%d window=%#x root=%#x expected=%#x", x, y, at, root, nw.hwnd)
	}
	smokeOnMain(t, func() error { nw.desired.ClickThrough = true; return nw.apply() })
	for _, delta := range []int32{0, 15, 30} {
		pt := uintptr(uint32(x+delta)) | uintptr(uint32(y+delta))<<32
		at, _, _ = fromPoint.Call(pt)
		root, _, _ = ancestor.Call(at, 2)
		if root == nw.hwnd {
			t.Errorf("click-through still owns WindowFromPoint at %d,%d: %#x", x+delta, y+delta, at)
		}
	}
	smokeOnMain(t, func() error { nw.desired.ClickThrough = false; return nw.apply() })
	at, _, _ = fromPoint.Call(point)
	root, _, _ = ancestor.Call(at, 2)
	if root != nw.hwnd {
		t.Errorf("hit routing did not return to fixture after disabling clickthrough: %#x", root)
	}
	assertFocus()
	t.Log("Read-only native WindowFromPoint passed before/during/after clickthrough; no mouse input generated")
}
