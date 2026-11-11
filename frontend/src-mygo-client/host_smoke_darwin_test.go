//go:build darwin && mygo_smoke

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"sharecode/client/assets"
	"sharecode/client/nativemac"
)

// The real host, with the real page (build-macos.sh embeds it), in real MyGo
// windows: the tests call the host as the page does and read AppKit back. They
// never generate input, ask for a permission or open System Settings, and use
// no saved session, update server or installed client: the app has its own
// name, directories and browsing session, and no update endpoint.

var (
	host     *Desktop
	mac      *darwinClient
	settings []string // the panes of System Settings the host would have opened
)

func TestMain(m *testing.M) {
	if os.Getenv("SHARECODE_MYGO_NATIVE_SMOKE") != "1" {
		fmt.Println("MyGo smoke disabled; set SHARECODE_MYGO_NATIVE_SMOKE=1 with -tags=mygo_smoke")
		os.Exit(m.Run())
	}
	root, err := os.MkdirTemp("", "sharecode-mygo-host-smoke-")
	if err != nil {
		panic(err)
	}
	applicationID = "dev.sharecode.client.host-smoke"
	applicationName = "sharecode-host-smoke-isolated"
	updateNodes = nil
	openSettings = func(url, name string) error { settings = append(settings, name); return nil }
	pageOptions = mygo.PageOptions{Session: mygo.NewEphemeralSession()}
	mygo.App.SetName(applicationName)
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(root, "profile"))
	mygo.App.SetPath(mygo.PathResources, "resources")
	mygo.App.SetMenu(nil)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	if err = mygo.Protocol.Handle("tauri", mygo.FileServer(assets.Files())); err != nil {
		panic(err)
	}
	host = &Desktop{}
	mygo.Bind(host)
	mygo.App.OnWindowAllClosed(func() {})
	code := 1
	mygo.App.WhenReady(func() {
		if err := host.open(assets.Files()); err != nil {
			fmt.Fprintln(os.Stderr, err)
			mygo.App.Quit()
			return
		}
		mac, _ = host.platform.(*darwinClient)
		go func() {
			code = m.Run()
			// The client's own way out: interactive, listener and capture
			// stopped off the UI thread, then the windows close.
			mygo.RunOnMain(host.beginShutdown)
		}()
	})
	if err = mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		code = 1
	}
	os.RemoveAll(root)
	os.RemoveAll(filepath.Join(os.Getenv("HOME"), "Library", "Logs", applicationID))
	os.Exit(code)
}

func smoke(t *testing.T) {
	t.Helper()
	if host == nil {
		t.Skip("set SHARECODE_MYGO_NATIVE_SMOKE=1 with -tags=mygo_smoke")
	}
	if mac == nil {
		t.Fatal("the native side did not attach: run nativemac/build-native.sh")
	}
}

func ui(t *testing.T, f func() error) {
	t.Helper()
	var err error
	mygo.RunOnMain(func() { err = f() })
	if err != nil {
		t.Fatal(err)
	}
}

// eval polls a page until script is true.
func eval(t *testing.T, page *mygo.Page, what, script string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for {
		value, err := page.EvalContext(ctx, script)
		if err == nil && value == true {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s: %v / %v", what, value, err)
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// call invokes a command of the main page the way Desktop.Invoke runs it.
func call(t *testing.T, command string, args map[string]any) (result any, err error) {
	t.Helper()
	mygo.RunOnMain(func() { result, err = host.windowCommand(command, args) })
	return
}

func guideWindow(t *testing.T) *mygo.Window {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if guide := mac.guide.Load(); guide != nil && !guide.IsDestroyed() {
			return guide
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the permission guide did not open")
	return nil
}

func TestHostServesThePageFromTheTauriOriginInAPreparedPanel(t *testing.T) {
	smoke(t)
	page := host.view.Page()
	eval(t, page, "the client page", `location.origin === "tauri://localhost" && typeof window.mygo?.call === "function" && document.documentElement.dataset.mygoClient === "true" && !!document.querySelector(".client-title-bar[data-macos='true']")`)
	// The page draws no opaque backdrop of its own: the window shows the desktop.
	eval(t, page, "a transparent page", `["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(document.documentElement).backgroundColor) && ["rgba(0, 0, 0, 0)", "transparent"].includes(getComputedStyle(document.body).backgroundColor)`)
	ui(t, func() error {
		state, err := mac.native.State()
		if err != nil || state != nativemac.DefaultStealth {
			return fmt.Errorf("launch state %+v, %v", state, err)
		}
		if mac.native.IsPinned() || host.main.IsMaximized() {
			return fmt.Errorf("the window launched pinned or maximized")
		}
		if !strings.Contains(mac.native.Diagnostics(), `"isPanel":true`) {
			return fmt.Errorf("not a panel: %s", mac.native.Diagnostics())
		}
		return nil
	})
}

func TestHostKeepsTheWindowBehindThePermissionGuide(t *testing.T) {
	smoke(t)
	if mac.hotkey.Available() {
		t.Skip("this process has Input Monitoring: the guide does not open")
	}
	// The page itself asked for the guide once the listener reported its phase.
	guide := guideWindow(t)
	eval(t, guide.Page(), "the guide", `location.hash.startsWith("#/input-monitoring") && !!document.querySelector("[data-testid='setup-drag-app']") && !!document.querySelector("[data-testid='setup-status']")?.textContent`)
	if len(settings) == 0 || settings[0] != "Input Monitoring" {
		t.Fatalf("panes opened: %v", settings)
	}
	ui(t, func() error {
		if host.main.IsVisible() {
			return fmt.Errorf("the main window shows without Input Monitoring")
		}
		if !guide.IsVisible() || guide.Title() != "Permission setup" && guide.Title() != "权限设置" {
			return fmt.Errorf("guide visible %v, title %q", guide.IsVisible(), guide.Title())
		}
		if width, height := guide.ContentSize(); width != 360 || height != 350 {
			return fmt.Errorf("guide is %dx%d", width, height)
		}
		return nil
	})
	if _, err := call(t, "show_client_main", nil); err == nil || !strings.Contains(err.Error(), "Input Monitoring") {
		t.Fatalf("show_client_main: %v", err)
	}
	if _, err := call(t, "set_stealth_state", map[string]any{"clickThrough": true, "screenCaptureProtection": true, "hideFromTaskbar": true, "changedField": "clickThrough"}); err == nil {
		t.Fatal("click-through was enabled without a listener")
	}
	if _, err := call(t, "test_client_hotkey", nil); err == nil {
		t.Fatal("a shortcut test started without a listener")
	}
	status, err := call(t, "get_client_hotkey_status", nil)
	if s, ok := status.(nativemac.Status); err != nil || !ok || s.Ready || s.Phase != "permissionRequired" {
		t.Fatalf("status %+v, %v", status, err)
	}
	// The guide is a page of its own with its own, smaller set of commands.
	guest := func(command string, args map[string]any) (any, error) {
		return mac.guestInvoke(guide.Page(), command, args)
	}
	if app, err := guest("get_client_application", nil); err != nil || app.(application).CanDrag {
		t.Fatalf("a test binary is no app to drag: %+v, %v", app, err)
	}
	if _, err := guest("drag_client_application", nil); err == nil {
		t.Fatal("a drag started outside an installed app")
	}
	if _, err := guest("client_screen_share", map[string]any{"action": "start", "language": "en"}); err == nil {
		t.Fatal("the guide started screen sharing")
	}
	if raw, err := guest("client_screen_share", map[string]any{"action": "status", "language": "en"}); err != nil || !json.Valid(raw.(json.RawMessage)) {
		t.Fatalf("recording status from the guide: %v, %v", raw, err)
	}
	for _, command := range []string{"set_stealth_state", "client_set_pinned", "set_client_update_locked", "client_update_check"} {
		if _, err := guest(command, map[string]any{"pinned": true, "locked": true}); err == nil {
			t.Fatalf("the guide ran %s", command)
		}
	}
	if _, err := mac.guestInvoke(host.view.Page(), "get_client_hotkey_status", nil); err == nil {
		t.Fatal("another page passed as the guide")
	}
	// The recording step reuses the window, and tells its page.
	ui(t, func() error { return mac.openGuide(false, true) })
	eval(t, guide.Page(), "the recording step", `location.hash.includes("recording=1")`)
	if mac.guide.Load() != guide || settings[len(settings)-1] != "Screen Recording" {
		t.Fatalf("a second guide opened, or the wrong pane: %v", settings)
	}
	// Later closes the guide; the gate stays, and the app keeps running hidden.
	if _, err := guest("client_window_close", nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for mac.guide.Load() != nil && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	ui(t, func() error {
		if mac.guide.Load() != nil || host.main.IsVisible() || host.main.IsDestroyed() {
			return fmt.Errorf("after Later: guide %v, main visible %v", mac.guide.Load() != nil, host.main.IsVisible())
		}
		return nil
	})
	// Opening the app again resumes the missing permission instead of the window.
	ui(t, func() error { mac.reopen(); return nil })
	guide = guideWindow(t)
	ui(t, func() error {
		if host.main.IsVisible() {
			return fmt.Errorf("reopening showed the main window")
		}
		guide.Close()
		return nil
	})
}

func TestHostSwitchesFollowThePageAndTheWindow(t *testing.T) {
	smoke(t)
	set := func(state nativemac.StealthState, field string) (nativemac.StealthState, error) {
		args := map[string]any{"clickThrough": state.ClickThrough, "screenCaptureProtection": state.ScreenCaptureProtection, "hideFromTaskbar": state.HideFromTaskbar}
		if field != "" {
			args["changedField"] = field
		}
		result, err := call(t, "set_stealth_state", args)
		got, _ := result.(nativemac.StealthState)
		return got, err
	}
	// Only the changed switch applies: the others keep what the window has.
	got, err := set(nativemac.StealthState{ScreenCaptureProtection: false, HideFromTaskbar: false}, "screenCaptureProtection")
	if want := (nativemac.StealthState{HideFromTaskbar: true}); err != nil || got != want {
		t.Fatalf("one switch: %+v, %v", got, err)
	}
	if _, err = set(nativemac.DefaultStealth, "opacity"); err == nil {
		t.Fatal("an unknown switch was accepted")
	}
	// The launch restore applies appearance and privacy, never click-through.
	got, err = set(nativemac.StealthState{ClickThrough: true, ScreenCaptureProtection: true, HideFromTaskbar: true}, "")
	if err != nil || got != nativemac.DefaultStealth {
		t.Fatalf("launch restore: %+v, %v", got, err)
	}
	if read, err := call(t, "get_stealth_state", nil); err != nil || read != nativemac.DefaultStealth {
		t.Fatalf("read back: %+v, %v", read, err)
	}
	for _, pinned := range []bool{true, false} {
		if _, err := call(t, "client_set_pinned", map[string]any{"pinned": pinned}); err != nil {
			t.Fatal(err)
		}
		ui(t, func() error {
			if mac.native.IsPinned() != pinned || host.main.IsAlwaysOnTop() != pinned {
				return fmt.Errorf("pinned %v: native %v, MyGo %v", pinned, mac.native.IsPinned(), host.main.IsAlwaysOnTop())
			}
			return nil
		})
	}
	if _, err := host.platform.meeting("get_meeting_privacy_status", nil); err == nil {
		t.Fatal("meeting filtering answered on macOS")
	}
	if maximized, err := call(t, "client_is_maximized", nil); err != nil || maximized != false {
		t.Fatalf("maximized %v, %v", maximized, err)
	}
}

func TestHostShowsAnUpdateWithoutPermissionsAndHidesAgain(t *testing.T) {
	smoke(t)
	opened := mac.mainOpened.Load()
	if _, err := call(t, "set_client_update_locked", map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	ui(t, func() error {
		if !host.main.IsVisible() {
			return fmt.Errorf("the update page is hidden")
		}
		if mac.mainOpened.Load() != opened {
			return fmt.Errorf("showing an update counted as opening the client")
		}
		return nil
	})
	// Nothing of a room works behind the update page.
	if _, err := call(t, "set_stealth_state", map[string]any{"clickThrough": true, "screenCaptureProtection": true, "hideFromTaskbar": true, "changedField": "clickThrough"}); err == nil {
		t.Fatal("click-through was enabled during an update")
	}
	if _, err := call(t, "client_screen_share", map[string]any{"action": "start", "language": "en"}); err == nil {
		t.Fatal("screen sharing started during an update")
	}
	if _, err := mac.toggle(nativemac.Action{Kind: nativemac.ToggleVisibility}); err == nil {
		t.Fatal("the shortcut hid the update page")
	}
	if _, err := call(t, "client_screen_share", map[string]any{"action": "status", "language": "en"}); err != nil {
		t.Fatal(err)
	}
	if _, err := call(t, "set_client_update_locked", map[string]any{"locked": false}); err != nil {
		t.Fatal(err)
	}
	ui(t, func() error {
		if !opened && host.main.IsVisible() {
			return fmt.Errorf("a withdrawn update left the window in front of the permission gate")
		}
		return nil
	})
}
