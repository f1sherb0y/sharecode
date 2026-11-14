//go:build darwin && mygo_smoke

package nativemac

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"sharecode/client/internal/clientview"
)

// Real MyGo panels with WebKit, as the host creates them. The tests read
// AppKit back and never generate input, ask for a permission, open System
// Settings or touch an installed client: the app has its own name and
// directories, and its page is a local fixture without network access.

const smokeHTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;background:transparent}#tile{position:absolute;left:24px;top:24px;width:120px;height:96px;background:rgb(230,40,80)}</style><div id="tile"></div><script>window.fixtureReady=true</script>`

func TestMain(m *testing.M) {
	if os.Getenv("SHARECODE_MYGO_NATIVE_SMOKE") != "1" {
		fmt.Println("MyGo smoke disabled; set SHARECODE_MYGO_NATIVE_SMOKE=1 with -tags=mygo_smoke")
		os.Exit(0)
	}
	root, err := os.MkdirTemp("", "sharecode-mygo-native-smoke-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(root)
	library, err := filepath.Abs(filepath.Join("..", "resources", "darwin", LibraryName))
	if err != nil {
		panic(err)
	}
	if err = Load(library); err != nil {
		panic(fmt.Sprintf("%v (run nativemac/build-native.sh)", err))
	}
	mygo.App.SetName("sharecode-native-smoke-isolated")
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(root, "profile"))
	mygo.App.SetMenu(nil)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	if err = mygo.Protocol.Handle("nativefixture", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, smokeHTML)
	})); err != nil {
		panic(err)
	}
	mygo.App.OnWindowAllClosed(func() {})
	code := 1
	mygo.App.WhenReady(func() { go func() { code = m.Run(); mygo.App.Quit() }() })
	if err = mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.RemoveAll(root)
	os.Exit(code)
}

func onMain(t *testing.T, f func() error) {
	t.Helper()
	var err error
	mygo.RunOnMain(func() { err = f() })
	if err != nil {
		t.Fatal(err)
	}
}

// Only one window can be prepared in a process, so every test shares it.
var (
	smokeView   *clientview.View
	smokeWindow *Window
)

func panel(t *testing.T) (*clientview.View, *Window) {
	t.Helper()
	if smokeWindow != nil {
		return smokeView, smokeWindow
	}
	onMain(t, func() error {
		view, err := clientview.New(mygo.WindowOptions{
			Title: "ShareCode native smoke (isolated)", URL: "nativefixture://localhost/",
			Width: 320, Height: 220, X: 80, Y: 120, Hidden: true, Frameless: true, CornerRadius: 10,
			DisableFullScreen: true, DisableMaximize: true, Panel: true,
			Page: mygo.PageOptions{Session: mygo.NewEphemeralSession()},
		})
		if err != nil {
			return err
		}
		native, err := Attach(view.Window.NativeHandle())
		if err != nil {
			view.Window.Destroy()
			return err
		}
		smokeView, smokeWindow = view, native
		return nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for {
		value, err := smokeView.Page().EvalContext(ctx, "window.fixtureReady === true")
		if err == nil && value == true {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("WebKit did not load the fixture: %v / %v", value, err)
		case <-time.After(50 * time.Millisecond):
		}
	}
	return smokeView, smokeWindow
}

type windowFacts struct {
	Class        string `json:"class"`
	IsPanel      bool   `json:"isPanel"`
	Level        int    `json:"level"`
	Behavior     uint   `json:"behavior"`
	Key          bool   `json:"key"`
	AppActive    bool   `json:"appActive"`
	Visible      bool   `json:"visible"`
	Pinned       bool   `json:"pinned"`
	CanBecomeKey bool   `json:"canBecomeKey"`
	IgnoresMouse bool   `json:"ignoresMouse"`
	Failure      string `json:"failure"`
}

func facts(t *testing.T, w *Window) (f windowFacts) {
	t.Helper()
	onMain(t, func() error { return json.Unmarshal([]byte(w.Diagnostics()), &f) })
	return
}

const (
	canJoinAllSpaces    = 1 << 0
	fullScreenAuxiliary = 1 << 8
	fullScreenNone      = 1 << 9
)

func TestMyGoPanelIsPreparedHiddenAndUnpinned(t *testing.T) {
	_, w := panel(t)
	f := facts(t, w)
	// The runtime class may be the subclass WebKit's observers installed.
	if !strings.HasSuffix(f.Class, "MyGoPanel") || !f.IsPanel || f.Visible || f.Pinned || f.Level != 0 || !f.CanBecomeKey {
		t.Fatalf("unexpected prepared panel: %+v", f)
	}
	if f.Behavior&canJoinAllSpaces != 0 || f.Behavior&fullScreenNone == 0 {
		t.Fatalf("an unpinned window must stay on one Space: behavior %#x", f.Behavior)
	}
	onMain(t, func() error {
		if _, err := Attach(smokeView.Window.NativeHandle()); err != nil {
			return fmt.Errorf("attaching again: %v", err)
		}
		return nil
	})
}

func TestMyGoStealthSwitchesAreReadBackFromAppKit(t *testing.T) {
	view, w := panel(t)
	onMain(t, func() error {
		state, err := w.SetStealth(DefaultStealth, false)
		if err != nil || state != DefaultStealth {
			return fmt.Errorf("defaults: %+v, %v", state, err)
		}
		view.Window.ShowInactive()
		return nil
	})
	before := facts(t, w)
	if !before.Visible {
		t.Fatal("the window did not show")
	}
	for _, next := range []StealthState{
		{ClickThrough: true, ScreenCaptureProtection: true, HideFromTaskbar: true},
		{ClickThrough: true, ScreenCaptureProtection: false, HideFromTaskbar: true},
		{ClickThrough: false, ScreenCaptureProtection: false, HideFromTaskbar: true},
		DefaultStealth,
	} {
		onMain(t, func() error {
			state, err := w.SetStealth(next, true)
			if err != nil || state != next {
				return fmt.Errorf("set %+v: %+v, %v", next, state, err)
			}
			if actual, err := w.State(); err != nil || actual != next {
				return fmt.Errorf("read back %+v: %+v, %v", next, actual, err)
			}
			return nil
		})
		f := facts(t, w)
		if f.IgnoresMouse != next.ClickThrough || f.CanBecomeKey == next.ClickThrough {
			t.Fatalf("click-through %v: ignoresMouse %v canBecomeKey %v", next.ClickThrough, f.IgnoresMouse, f.CanBecomeKey)
		}
		if f.Key != before.Key || f.AppActive != before.AppActive || !f.Visible {
			t.Fatalf("the focus-preserving path changed focus: before %+v after %+v", before, f)
		}
	}
}

func TestMyGoPinningFloatsOverSpacesAndRestores(t *testing.T) {
	view, w := panel(t)
	onMain(t, func() error { view.Window.ShowInactive(); return nil })
	before := facts(t, w)
	onMain(t, func() error { return w.SetPinned(true) })
	pinned := facts(t, w)
	if !pinned.Pinned || pinned.Level != 3 || pinned.Behavior&(canJoinAllSpaces|fullScreenAuxiliary) != canJoinAllSpaces|fullScreenAuxiliary {
		t.Fatalf("not pinned: %+v", pinned)
	}
	if pinned.Key != before.Key || pinned.AppActive != before.AppActive {
		t.Fatalf("pinning changed focus: before %+v after %+v", before, pinned)
	}
	onMain(t, func() error {
		if !w.IsPinned() {
			return fmt.Errorf("IsPinned is false")
		}
		// MyGo's own level follows, so that showing again keeps the window floating.
		view.Window.SetAlwaysOnTop(true)
		view.Window.ShowInactive()
		if !w.IsPinned() {
			return fmt.Errorf("showing the window unpinned it")
		}
		if err := w.SetPinned(false); err != nil {
			return err
		}
		view.Window.SetAlwaysOnTop(false)
		return nil
	})
	after := facts(t, w)
	if after.Pinned || after.Level != before.Level || after.Behavior != before.Behavior {
		t.Fatalf("unpinning did not restore: before %+v after %+v", before, after)
	}
}

func TestMyGoHidingAndMovingLeaveFocusAlone(t *testing.T) {
	view, w := panel(t)
	onMain(t, func() error { view.Window.ShowInactive(); return nil })
	before := facts(t, w)
	var start, moved, back geometry
	onMain(t, func() (err error) {
		if start, err = w.geometry(); err != nil {
			return
		}
		if err = w.Move(1, 1); err != nil {
			return
		}
		if moved, err = w.geometry(); err != nil {
			return
		}
		if err = w.Move(-1, -1); err != nil {
			return
		}
		back, err = w.geometry()
		return
	})
	// Down is a smaller y in AppKit.
	if moved.X != start.X+MoveStep || moved.Y != start.Y-MoveStep || back.X != start.X || back.Y != start.Y {
		t.Fatalf("move: start %+v moved %+v back %+v", start, moved, back)
	}
	onMain(t, func() error {
		if w.ToggleVisibility() {
			return fmt.Errorf("the window did not hide")
		}
		if reachable, err := w.Reachable(); err != nil || reachable {
			return fmt.Errorf("a hidden window is reachable: %v", err)
		}
		if err := w.Move(1, 0); err != nil {
			return err
		}
		if hidden, err := w.geometry(); err != nil || hidden.X != start.X {
			return fmt.Errorf("a hidden window moved: %+v, %v", hidden, err)
		}
		if !w.ToggleVisibility() {
			return fmt.Errorf("the window did not show again")
		}
		return nil
	})
	after := facts(t, w)
	if after.Key != before.Key || after.AppActive != before.AppActive || !after.Visible {
		t.Fatalf("hide/show or move changed focus: before %+v after %+v", before, after)
	}
}

func TestMyGoRecordingStatusNeverStartsCapture(t *testing.T) {
	panel(t)
	onMain(t, func() error {
		raw, err := ScreenShare(ShareStatus, 0, false)
		if err != nil {
			return err
		}
		var state struct {
			Supported, Permission, Running bool
			Phase                          string
		}
		if err = json.Unmarshal(raw, &state); err != nil {
			return err
		}
		if state.Running {
			return fmt.Errorf("reading the status started sharing: %s", raw)
		}
		supported, granted, err := RecordingPermission()
		if err != nil || supported != state.Supported || granted != state.Permission {
			return fmt.Errorf("permission %v/%v, %v against %s", supported, granted, err, raw)
		}
		StopScreenShare()
		return nil
	})
}
