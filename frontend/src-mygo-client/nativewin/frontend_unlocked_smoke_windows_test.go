//go:build windows && mygo_smoke

package nativewin

import (
	"bytes"
	"errors"
	"fmt"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/egoist/mygo"
	"sharecode/client/internal/clientview"
)

// Per-caller opt-in keeps the existing mandatory-error fixture unchanged.
// Native window commands below operate on actual owned HWNDs; no listener or
// meeting protection is fabricated. No updater transport/installer is started.
var unlockedFrontendFixtures sync.Map

type unlockedFrontendFixture struct {
	native          *Window
	mu              sync.Mutex
	checked, locked bool
	calls           map[string]int
	failures        map[string]int
	gate            []string
}

func (f *unlockedFrontendFixture) invoke(caller *mygo.Window, command string, args map[string]any) (result any, err error) {
	f.mu.Lock()
	f.calls[command]++
	f.mu.Unlock()
	defer func() {
		if err != nil {
			f.mu.Lock()
			f.failures[command]++
			f.mu.Unlock()
		}
	}()
	switch command {
	case "client_update_check":
		f.mu.Lock()
		f.checked = true
		f.gate = append(f.gate, "checked-null")
		f.mu.Unlock()
		return nil, nil // Explicit JSON null, not an error/undefined disguised as current.
	case "set_client_update_locked":
		locked, ok := args["locked"].(bool)
		if !ok {
			return nil, errors.New("locked boolean required")
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if !locked && !f.checked {
			return nil, errors.New("fixture cannot unlock before explicit no-update check")
		}
		if locked {
			f.checked = false
			f.gate = append(f.gate, "locked")
		} else {
			f.gate = append(f.gate, "unlocked")
		}
		f.locked = locked
		return nil, nil
	case "get_meeting_privacy_status":
		return MeetingStatus{State: "disabled"}, nil
	case "set_meeting_privacy_enabled":
		return nil, errors.New("meeting filtering is unavailable in isolated frontend fixture")
	case "fixture_call_counts":
		f.mu.Lock()
		defer f.mu.Unlock()
		copy := map[string]int{}
		for k, v := range f.calls {
			copy[k] = v
		}
		return copy, nil
	case "get_stealth_state", "set_stealth_state", "get_hotkey_status", "client_set_pinned", "client_window_set_title", "client_is_maximized", "fixture_is_pinned":
		mygo.RunOnMain(func() {
			switch command {
			case "get_stealth_state":
				result, err = f.native.State()
			case "set_stealth_state":
				click, clickOK := args["clickThrough"].(bool)
				capture, captureOK := args["screenCaptureProtection"].(bool)
				hidden, hiddenOK := args["hideFromTaskbar"].(bool)
				if !clickOK || !captureOK || !hiddenOK {
					err = errors.New("stealth booleans required")
					return
				}
				result, err = f.native.SetStealth(StealthState{ClickThrough: click, ScreenCaptureProtection: capture, HideFromTaskbar: hidden})
			case "get_hotkey_status":
				result = f.native.HotkeyStatus()
			case "client_set_pinned":
				pin, ok := args["pinned"].(bool)
				if !ok {
					err = errors.New("pinned boolean required")
					return
				}
				err = f.native.SetPinned(pin)
			case "client_window_set_title":
				title, ok := args["title"].(string)
				if !ok {
					err = errors.New("title string required")
					return
				}
				caller.SetTitle(title)
			case "client_is_maximized":
				result = caller.IsMaximized()
			case "fixture_is_pinned":
				result, err = f.native.IsPinned()
			}
		})
		return result, err
	default:
		return nil, fmt.Errorf("unknown unlocked fixture command %q", command)
	}
}
func (f *unlockedFrontendFixture) count(command string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[command]
}
func (f *unlockedFrontendFixture) failureCount(command string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.failures[command]
}
func unlockedScreenshot(t *testing.T, w *mygo.Window, name string) {
	t.Helper()
	data, err := captureForSmoke(w)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(smokeRoot, name+".png"), data, 0600); err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	appearance := smokeEval(t, w, "({dpr:devicePixelRatio,alpha:Number(document.body.style.getPropertyValue('--client-bg-alpha'))})").(map[string]any)
	x, y := int(20*appearance["dpr"].(float64)), int(100*appearance["dpr"].(float64))
	_, _, _, alpha := img.At(x, y).RGBA()
	want := int(math.Round(255 * appearance["alpha"].(float64)))
	got := int(alpha >> 8)
	if got < want-1 || got > want+1 {
		t.Fatalf("%s blank frontend surface alpha=%d want=%d; CSS alpha alone is not visual proof", name, got, want)
	}
	t.Logf("%s real frontend blank-body pixel alpha=%d (expected CSS background %d); native DWM composition checked separately", name, got, want)
}
func nativeFixtureEvent(t *testing.T, w *mygo.Window, name string, value any) {
	t.Helper()
	if err := fixtureEvent.EmitPage(pageForSmoke(w), fixtureEnvelope{name, value}); err != nil {
		t.Fatal(err)
	}
}

func TestMyGoUnlockedCustomerFrontend(t *testing.T) {
	variants := []struct{ language, theme, title, settings, opaque, recommended string }{
		{"en", "light", "Join a Room", "Window settings", "Opaque", "Recommended"},
		{"zh", "dark", "加入房间", "窗口设置", "不透明", "推荐"},
	}
	for _, variant := range variants {
		t.Run(variant.language+"-"+variant.theme, func(t *testing.T) {
			foreground := user32.NewProc("GetForegroundWindow")
			before, _, _ := foreground.Call()
			fixture := &unlockedFrontendFixture{calls: map[string]int{}, failures: map[string]int{}}
			preload := frontendPreload + fmt.Sprintf(`
if(!localStorage.getItem('__unlockedFixtureSeeded')){
 localStorage.clear();localStorage.setItem('__unlockedFixtureSeeded','1');
 localStorage.setItem('i18nextLng',%q);
 localStorage.setItem('theme-storage',JSON.stringify({state:{theme:%q},version:0}));
}
window.__unlockedErrors=[];
window.addEventListener('error',e=>window.__unlockedErrors.push(String(e.message)));
window.addEventListener('unhandledrejection',e=>window.__unlockedErrors.push(String(e.reason)));
`, variant.language, variant.theme)
			var w *mygo.Window
			smokeOnMain(t, func() error {
				opts := mygo.WindowOptions{Title: "ShareCode unlocked UI acceptance (isolated)", URL: "tauri://localhost/client.html", Width: 760, Height: 680, MinWidth: 480, MinHeight: 360, CornerRadius: 10, Hidden: true, Frameless: true, Transparent: true, BackgroundColor: "#00000000", SkipTaskbar: true, Page: mygo.PageOptions{PreloadScript: preload, Session: mygo.NewSession("unlocked-ui-" + variant.language + "-" + variant.theme), BackgroundThrottling: mygo.ThrottlingOff}}
				view, err := clientview.New(opts)
				if err != nil {
					return err
				}
				w = view.Window
				embeddedSmokeViews.Store(w.ID(), view.WebView)
				fixture.native, err = Attach(w.NativeHandle(), Options{CustomWindowControls: true, Dispatch: mygo.RunOnMain, SetTaskbarHidden: func(hidden bool) error { w.SetSkipTaskbar(hidden); return nil }})
				if err != nil {
					return err
				}
				unlockedFrontendFixtures.Store(w.ID(), fixture)
				r, _, e := setWindowPos.Call(w.NativeHandle(), 0, 23000, 23000, 760, 680, 4|0x10)
				if err = apiError("SetWindowPos isolated unlocked frontend", r, e); err != nil {
					return err
				}
				showWindow.Call(w.NativeHandle(), 4)
				return nil
			})
			t.Cleanup(func() {
				smokeOnMain(t, func() error {
					err := fixture.native.Close()
					w.Destroy()
					unlockedFrontendFixtures.Delete(w.ID())
					embeddedSmokeViews.Delete(w.ID())
					return err
				})
			})
			smokeWait(t, w, "document.querySelector('#shareInput')!==null && document.querySelector('.client-title-bar')!==null && document.querySelector('button[aria-keyshortcuts]').disabled===false")
			smokeWait(t, w, fmt.Sprintf("document.documentElement.dataset.mygoClient==='true'&&document.documentElement.dataset.theme===%q&&document.body.innerText.includes(%q)", variant.theme, variant.title))
			identity := smokeEval(t, w, "({origin:location.origin,mygo:document.documentElement.dataset.mygoClient,tauri:typeof window.__TAURI_INTERNALS__,title:document.title,lang:document.documentElement.lang,theme:document.documentElement.dataset.theme,body:document.body.innerText})")
			t.Logf("unlocked bundled frontend identity: %#v", identity)
			m := identity.(map[string]any)
			if m["origin"] != "http://tauri.localhost" || m["tauri"] != "undefined" || m["title"] != "ShareCode" {
				t.Fatalf("unexpected unlocked identity %+v", m)
			}
			fixture.mu.Lock()
			gate := append([]string(nil), fixture.gate...)
			locked := fixture.locked
			fixture.mu.Unlock()
			// The client opens without the gate: one check, answered "no update".
			if locked || len(gate) != 1 || gate[0] != "checked-null" {
				t.Fatalf("unexpected update gate calls: %v locked=%v", gate, locked)
			}
			if got := smokeEval(t, w, "document.querySelector('.client-update-error')===null&&document.querySelector('form button[type=submit]').disabled"); got != true {
				t.Fatal("unexpected gate or enabled empty invite submission")
			}
			unlockedScreenshot(t, w, "unlocked-home-"+variant.language+"-"+variant.theme)
			if os.Getenv("SHARECODE_MYGO_CAPTION_SMOKE") == "1" {
				nativeCaptionProbe(t, w, fixture.native, variant.language+"-"+variant.theme)
			}
			// DOM .click() delivers ordinary React handlers without sending OS input.
			smokeEval(t, w, fmt.Sprintf("document.querySelector('button[aria-label=%q]').click()", variant.settings))
			smokeWait(t, w, "document.querySelectorAll('.client-opacity-slider').length===2&&document.querySelector('.client-hotkey-status')?.dataset.state==='error'")
			smokeEval(t, w, fmt.Sprintf("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()===%q).click()", variant.opaque))
			smokeWait(t, w, "document.body.style.getPropertyValue('--client-text-alpha')==='1'&&document.body.style.getPropertyValue('--client-bg-alpha')==='1'")
			smokeEval(t, w, fmt.Sprintf("Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()===%q).click()", variant.recommended))
			smokeWait(t, w, "document.body.style.getPropertyValue('--client-text-alpha')==='0.9'&&document.body.style.getPropertyValue('--client-bg-alpha')==='0.65'")
			nativeFixtureEvent(t, w, "sharecode:opacity-step", -1)
			smokeWait(t, w, "document.body.style.getPropertyValue('--client-text-alpha')==='0.9'&&document.body.style.getPropertyValue('--client-bg-alpha')==='0.55'")
			// Capture protection is applied to and read back from this actual HWND.
			smokeEval(t, w, "document.querySelector('.client-stealth-row').click()")
			smokeWait(t, w, "document.querySelector('.client-stealth-row').getAttribute('aria-pressed')==='false'&&!document.querySelector('.client-stealth-row').disabled")
			smokeOnMain(t, func() error {
				state, err := fixture.native.State()
				if err != nil {
					return err
				}
				if state.ScreenCaptureProtection {
					return errors.New("capture UI did not update actual HWND")
				}
				return nil
			})
			smokeEval(t, w, "document.querySelector('.client-stealth-row').click()")
			smokeWait(t, w, "document.querySelector('.client-stealth-row').getAttribute('aria-pressed')==='true'&&!document.querySelector('.client-stealth-row').disabled")
			// No global listener was started. The real public guard must reject F's UI
			// equivalent, and the page must sync back to actual false rather than lie.
			smokeEval(t, w, "document.querySelector('button[aria-keyshortcuts]').click()")
			smokeWait(t, w, "!document.querySelector('button[aria-keyshortcuts]').disabled&&document.querySelector('button[aria-keyshortcuts]').getAttribute('aria-pressed')==='false'&&document.querySelector('[data-sonner-toast]')!==null")
			if fixture.failureCount("set_stealth_state") != 1 {
				t.Fatal("missing honest native listener rejection")
			}
			smokeEval(t, w, "document.querySelector('[data-testid=meeting-privacy] button').click()")
			smokeWait(t, w, "document.querySelector('[data-testid=meeting-privacy] [role=alert]')?.textContent.includes('meeting filtering is unavailable in isolated frontend fixture')===true")
			if got := smokeEval(t, w, "document.querySelector('[data-testid=meeting-privacy] button').getAttribute('aria-pressed')"); got != "false" {
				t.Fatal("meeting fixture rejection did not restore disabled switch")
			}
			unlockedScreenshot(t, w, "unlocked-settings-"+variant.language+"-"+variant.theme)
			// Close settings and exercise genuine command and event alias paths for pin.
			smokeEval(t, w, fmt.Sprintf("document.querySelector('button[aria-label=%q]').click()", variant.settings))
			smokeEval(t, w, "document.querySelector('.client-title-button svg.lucide-pin').closest('button').click()")
			smokeWait(t, w, "document.querySelector('.client-title-button svg.lucide-pin').closest('button').getAttribute('aria-pressed')==='true'")
			smokeWait(t, w, "mygo.call('Desktop.Invoke','fixture_is_pinned',{}).then(pin=>pin===true)")
			smokeOnMain(t, func() error {
				pin, err := fixture.native.IsPinned()
				if err != nil {
					return err
				}
				if !pin {
					return errors.New("frontend pin did not reach actual HWND")
				}
				return fixture.native.SetPinned(false)
			})
			nativeFixtureEvent(t, w, "sharecode:pin-state", false)
			smokeWait(t, w, "document.querySelector('.client-title-button svg.lucide-pin').closest('button').getAttribute('aria-pressed')==='false'")
			beforeResize := fixture.count("client_is_maximized")
			nativeFixtureEvent(t, w, "tauri://resize", map[string]int{"width": 760, "height": 680})
			smokeWait(t, w, fmt.Sprintf("mygo.call('Desktop.Invoke','fixture_call_counts',{}).then(c=>c.client_is_maximized>%d)", beforeResize))
			if fixture.failureCount("client_set_pinned") != 0 {
				t.Fatal("native pin error was swallowed by optimistic UI")
			}
			if network := smokeEval(t, w, "window.__smokeNetworkAttempts.length"); network != float64(0) {
				t.Fatalf("unlocked interactions attempted network before reload: %#v", network)
			}
			if errs := smokeEval(t, w, "window.__unlockedErrors").([]any); len(errs) != 0 {
				t.Fatalf("unhandled interaction errors before reload: %#v", errs)
			}
			pageForSmoke(w).Reload()
			smokeWait(t, w, "document.querySelector('#shareInput')!==null&&document.body.style.getPropertyValue('--client-bg-alpha')==='0.55'&&document.body.style.getPropertyValue('--client-text-alpha')==='0.9'")
			if os.Getenv("SHARECODE_MYGO_VISIBLE_SMOKE") == "1" {
				visibleFrontendComposition(t, w, fixture.native)
			}
			if network := smokeEval(t, w, "window.__smokeNetworkAttempts.length"); network != float64(0) {
				t.Fatalf("unlocked shell attempted network: %#v", network)
			}
			if errs := smokeEval(t, w, "window.__unlockedErrors").([]any); len(errs) != 0 {
				t.Fatalf("unhandled renderer errors: %#v", errs)
			}
			for _, command := range []string{"client_update_check", "get_hotkey_status", "get_stealth_state", "set_stealth_state", "client_set_pinned", "client_window_set_title", "client_is_maximized", "get_meeting_privacy_status"} {
				if fixture.count(command) < 1 {
					t.Fatalf("actual transport alias never invoked %s", command)
				}
			}
			after, _, _ := foreground.Call()
			if after != before && ownsWindow(after) {
				t.Fatalf("unlocked DOM-only fixture changed foreground %#x -> %#x", before, after)
			}
			t.Log("PASS: actual bundled unlocked join/titlebar, root marker, language/theme hydration, native Ghost/pin IPC, honest missing-listener/meeting errors, opacity/native events/resize aliases and persisted reload; no network/input/hooks")
		})
	}
}
