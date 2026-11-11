//go:build windows && mygo_smoke

package nativewin

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
	"sharecode/client/assets"
	"sharecode/client/internal/clientview"
)

type fixtureEnvelope struct {
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

var fixtureEvent = mygo.NewEvent[fixtureEnvelope]("sharecode:native-event")

// Desktop is a real bound Go service with the production service name. It is
// intentionally a strict fixture: no native updates, network or meeting control.
// It does not replace window.mygo or inject a JavaScript transport.
type Desktop struct {
	mu    sync.Mutex
	calls map[string]int
}

var fixtureDesktop = &Desktop{calls: map[string]int{}}

func (d *Desktop) Invoke(ctx context.Context, command string, args map[string]any) (any, error) {
	caller := mygo.CallerWindow(ctx)
	if caller == nil || mygo.CallerPage(ctx) != pageForSmoke(caller) {
		return nil, errors.New("fixture requires authenticated calling WebView")
	}
	d.mu.Lock()
	d.calls[command]++
	d.mu.Unlock()
	if value, ok := unlockedFrontendFixtures.Load(caller.ID()); ok {
		return value.(*unlockedFrontendFixture).invoke(caller, command, args)
	}
	switch command {
	case "set_client_update_locked":
		locked, ok := args["locked"].(bool)
		if !ok || !locked {
			return nil, errors.New("fixture only accepts locked update gate")
		}
		return nil, nil
	case "client_update_check":
		return map[string]any{"id": "fixture", "currentVersion": "0.0.1", "version": "9.9.9"}, nil
	case "client_update_download":
		return nil, errors.New("isolated smoke fixture: no download")
	case "client_update_close":
		return nil, nil
	case "fixture_probe":
		nonce, ok := args["nonce"].(string)
		if !ok || nonce == "" {
			return nil, errors.New("fixture nonce required")
		}
		return map[string]any{"nonce": nonce, "caller": caller.ID()}, nil
	case "fixture_event":
		nonce, ok := args["nonce"].(string)
		if !ok || nonce == "" {
			return nil, errors.New("fixture nonce required")
		}
		return nil, fixtureEvent.EmitPage(mygo.CallerPage(ctx), fixtureEnvelope{"fixture:echo", map[string]any{"nonce": nonce}})
	default:
		return nil, fmt.Errorf("unknown isolated fixture command %q", command)
	}
}
func configureFrontendSmoke() error {
	mygo.Bind(fixtureDesktop)
	handler := mygo.FileServer(assets.Files())
	return mygo.Protocol.Handle("tauri", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Browser loading is restricted independently of our fetch/WebSocket guards.
		// External fonts/images/frames/connections cannot escape to production.
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'")
		handler.ServeHTTP(w, r)
	}))
}

const frontendPreload = `
window.__smokeNetworkAttempts=[];
window.fetch=(...args)=>{window.__smokeNetworkAttempts.push(String(args[0]));return Promise.reject(new Error('network disabled in isolated native smoke'))};
window.WebSocket=class {constructor(url){window.__smokeNetworkAttempts.push(String(url));throw new Error('WebSocket disabled in isolated native smoke')}};
navigator.sendBeacon=()=>false;
window.__smokeBoot=Number(localStorage.getItem('__nativeSmokeBoot')||0)+1;
localStorage.setItem('__nativeSmokeBoot',String(window.__smokeBoot));
`

func smokeEval(t *testing.T, w *mygo.Window, script string) any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	value, err := pageForSmoke(w).EvalContext(ctx, script)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func smokeWait(t *testing.T, w *mygo.Window, script string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	var value any
	var err error
	for {
		value, err = pageForSmoke(w).EvalContext(ctx, script)
		if err == nil && value == true {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("frontend condition timeout: %s; last=%#v err=%v", script, value, err)
		case <-ticker.C:
		}
	}
}
func TestMyGoRealFrontendSchemeBridgeAndStorage(t *testing.T) {
	if _, err := fs.Stat(assets.Files(), "client.html"); err != nil {
		t.Fatal("the customer frontend is not built:", err)
	}
	foreground := user32.NewProc("GetForegroundWindow")
	before, _, _ := foreground.Call()
	var w *mygo.Window
	smokeOnMain(t, func() error {
		view, err := clientview.New(mygo.WindowOptions{Title: "ShareCode real frontend smoke (isolated)", URL: "tauri://localhost/client.html", Width: 640, Height: 480, Hidden: true, Frameless: true, Transparent: true, BackgroundColor: "#00000000", SkipTaskbar: true, Page: mygo.PageOptions{PreloadScript: frontendPreload, Session: mygo.NewSession("native-frontend-smoke"), BackgroundThrottling: mygo.ThrottlingOff}})
		if err != nil {
			return err
		}
		w = view.Window
		embeddedSmokeViews.Store(w.ID(), view.WebView)
		r, _, e := setWindowPos.Call(w.NativeHandle(), 0, 22000, 22000, 640, 480, 4|0x10)
		return apiError("SetWindowPos offscreen frontend", r, e)
	})
	t.Cleanup(func() { w.Destroy(); embeddedSmokeViews.Delete(w.ID()) })
	// The fixture offers an update whose download fails, so the page's requests
	// reach the Go service and the update gate closes with an error.
	smokeWait(t, w, "document.querySelector('.client-update-error') !== null")
	smokeOnMain(t, func() error { showWindow.Call(w.NativeHandle(), 4); return nil })
	identity := smokeEval(t, w, "({href:location.href,origin:location.origin,bridge:typeof window.mygo?.call,tauri:typeof window.__TAURI_INTERNALS__,boot:window.__smokeBoot,network:window.__smokeNetworkAttempts,body:document.body.innerText})")
	t.Logf("actual bundled frontend identity/state: %#v", identity)
	m, ok := identity.(map[string]any)
	if !ok {
		t.Fatalf("bad identity result %#v", identity)
	}
	// MyGo Windows maps custom schemes through WebResourceRequested at the
	// secure-context localhost origin, matching Tauri's default non-HTTPS scheme.
	if m["href"] != "http://tauri.localhost/client.html#/" || m["origin"] != "http://tauri.localhost" || m["bridge"] != "function" || m["tauri"] != "undefined" {
		t.Fatalf("unexpected native origin/bridge: %#v", identity)
	}
	fixtureDesktop.mu.Lock()
	checks, locks := fixtureDesktop.calls["client_update_check"], fixtureDesktop.calls["set_client_update_locked"]
	fixtureDesktop.mu.Unlock()
	if checks < 1 || locks < 1 {
		t.Fatalf("real frontend did not invoke native update gate: check=%d lock=%d", checks, locks)
	}
	nonce := fmt.Sprintf("native-%d", time.Now().UnixNano())
	script := fmt.Sprintf("mygo.call('Desktop.Invoke','fixture_probe',{nonce:%q})", nonce)
	probe := smokeEval(t, w, script).(map[string]any)
	if probe["nonce"] != nonce || probe["caller"] != float64(w.ID()) {
		t.Fatalf("authenticated caller/result mismatch: %#v", probe)
	}
	rejected := smokeEval(t, w, "mygo.call('Desktop.Invoke','forbidden_command',{}).then(()=>false,e=>String(e).includes('unknown isolated fixture command'))")
	if rejected != true {
		t.Fatal("unknown native command did not reject")
	}
	event := smokeEval(t, w, fmt.Sprintf(`new Promise(async(resolve,reject)=>{const stop=mygo.on('sharecode:native-event',m=>{if(m.event==='fixture:echo'){stop();resolve(m.payload.nonce)}});try{await mygo.call('Desktop.Invoke','fixture_event',{nonce:%q})}catch(e){stop();reject(e)}})`, nonce))
	if event != nonce {
		t.Fatalf("native event result mismatch: %#v", event)
	}
	boot := smokeEval(t, w, fmt.Sprintf("localStorage.setItem('__nativeSmokeSentinel',%q); return window.__smokeBoot", nonce)).(float64)
	pageForSmoke(w).Reload()
	smokeWait(t, w, fmt.Sprintf("window.__smokeBoot > %d && document.querySelector('.client-update-error') !== null", int(boot)))
	if got := smokeEval(t, w, "localStorage.getItem('__nativeSmokeSentinel')"); got != nonce {
		t.Fatalf("custom-scheme localStorage lost on real reload: %#v", got)
	}
	// No production API/WS was even attempted while the real update gate stayed
	// locked; CSP independently forbids browser-originated external resource loads.
	if attempts := smokeEval(t, w, "window.__smokeNetworkAttempts.length"); attempts != float64(0) {
		t.Fatalf("unexpected network attempt from gated frontend: %#v", attempts)
	}
	png, err := captureForSmoke(w)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(smokeRoot, "real-frontend-update-gate.png"), png, 0600); err != nil {
		t.Fatal(err)
	}
	after, _, _ := foreground.Call()
	if after != before && ownsWindow(after) {
		t.Fatalf("real frontend fixture changed foreground: %#x -> %#x", before, after)
	}
	if _, err = os.Stat(filepath.Join(smokeRoot, "WebView2")); err != nil {
		t.Fatalf("WebView2 did not create isolated configured user-data directory: %v", err)
	}
	t.Log("PASS: actual bundled frontend tauri origin, real injected MyGo IPC/caller/errors/events, mandatory-gate rejection and localStorage across reload; no network/input/native hooks")
}
