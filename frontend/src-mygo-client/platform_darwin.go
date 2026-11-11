//go:build darwin

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/egoist/mygo"
	"sharecode/client/nativemac"
)

// The main window stays hidden until Input Monitoring and Screen Recording are
// ready (show_client_main), or an update has to be shown.
const showWhenReady = false

// The window is one of MyGo's nonactivating panels, which nativemac prepares.
// It is not maximizable: a zoomed borderless translucent window loses its
// rounded frame and can disappear behind the full-screen bounds.
func platformWindowOptions(opts *mygo.WindowOptions) {
	opts.Panel = true
	opts.DisableMaximize = true
}

const (
	inputMonitoringSettings = "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
	screenRecordingSettings = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
	guideURL                = "tauri://localhost/client.html#/input-monitoring"
)

var errWindowsOnly = errors.New("Meeting-window privacy is available on Windows only")

type darwinClient struct {
	desktop *Desktop
	window  *mygo.Window
	native  *nativemac.Window
	hotkey  *nativemac.Hotkey
	// Set once both permissions were ready and the window was shown; until then
	// click-through is refused and an unlocked update gate hides the window again.
	mainOpened atomic.Bool
	// The permission guide, while it is open: an opaque window of its own,
	// independent of the room's opacity, click-through, pinning and session.
	guide atomic.Pointer[mygo.Window]
}

func nativeLibrary() (string, error) {
	resources, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return "", err
	}
	// In the app's Resources, or the project's resources directory under go run.
	for _, path := range []string{
		filepath.Join(resources, nativemac.LibraryName),
		filepath.Join(resources, "darwin", nativemac.LibraryName),
	} {
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s is not among the resources: run nativemac/build-native.sh", nativemac.LibraryName)
}

func attachPlatform(d *Desktop, w *mygo.Window) (platformClient, error) {
	library, err := nativeLibrary()
	if err != nil {
		return nil, err
	}
	if err = nativemac.Load(library); err != nil {
		return nil, err
	}
	p := &darwinClient{desktop: d, window: w}
	if p.native, err = nativemac.Attach(w.NativeHandle()); err != nil {
		return nil, err
	}
	if _, err = p.native.SetStealth(nativemac.DefaultStealth, false); err != nil {
		log.Printf("Stealth defaults: %v", err)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	// Where the Tauri client kept it: ~/Library/Logs/<identifier>.
	diagnostics, err := nativemac.NewDiagnostics(filepath.Join(home, "Library", "Logs", applicationID))
	if err != nil {
		log.Printf("Hotkey diagnostics: %v", err)
	}
	diagnostics.Record("nativeWindowPrepared", map[string]string{
		"identifier": applicationID, "version": applicationVersion, "window": p.native.Diagnostics(),
	})
	p.hotkey, err = nativemac.NewHotkey(nativemac.HotkeyOptions{
		Log: diagnostics, Dispatch: mygo.RunOnMain,
		Toggle: p.toggle, Move: p.move, Recover: p.recoverWindow,
		Opacity:           func(direction int) { d.emit("sharecode:opacity-step", direction) },
		Quit:              mygo.App.Quit,
		OnStatus:          func(status nativemac.Status) { p.emit("sharecode:hotkey-status", status) },
		WindowDiagnostics: p.native.Diagnostics,
	})
	if err != nil {
		return nil, err
	}
	p.hotkey.Start()
	// The listen-only tap decides and performs every action; these registrations
	// only make macOS consume the chords. They need no permission, and a chord
	// another app holds still acts, unabsorbed.
	var notAbsorbed []string
	for _, chord := range nativemac.AbsorbedChords {
		if err := mygo.GlobalShortcut.Register(chord, func() {}); err != nil {
			notAbsorbed = append(notAbsorbed, chord)
		}
	}
	diagnostics.Record("absorbChords", map[string]any{"notAbsorbed": notAbsorbed})
	// Opening the app again is a recovery action, unlike the focus-neutral shortcut.
	mygo.App.OnActivate(func(bool) { p.reopen() })
	return p, nil
}

// emit also reaches the permission guide, which shows the listener's status.
func (p *darwinClient) emit(event string, payload any) {
	p.desktop.emit(event, payload)
	if guide := p.guide.Load(); guide != nil && !guide.IsDestroyed() {
		if err := nativeEvent.EmitPage(guide.Page(), NativeEvent{Event: event, Payload: payload}); err != nil {
			log.Printf("Native event %s: %v", event, err)
		}
	}
}

func (p *darwinClient) state() nativemac.StealthState {
	state, err := p.native.State()
	if err != nil {
		return nativemac.DefaultStealth
	}
	return state
}

// setPinned keeps MyGo's own record of the level in step, so that MyGo never
// puts the window back where it was.
func (p *darwinClient) setPinned(pinned bool) error {
	if err := p.native.SetPinned(pinned); err != nil {
		return err
	}
	p.window.SetAlwaysOnTop(pinned)
	return nil
}

// writeState is the one path of the switches, for the title bar and the
// shortcut. It pins before making the window non-interactive; turning
// click-through off leaves pinning for the user to change.
func (p *darwinClient) writeState(next nativemac.StealthState, preserveFocus bool) (nativemac.StealthState, error) {
	if next.ClickThrough && p.desktop.locked.Load() {
		return next, errors.New("Click-through is unavailable while an update is required")
	}
	// A hidden, input-transparent window needs a working listener to come back.
	if next.ClickThrough && (!p.mainOpened.Load() || !p.hotkey.Available()) {
		return next, errors.New("The native shortcut needs Input Monitoring; click-through was not enabled")
	}
	wasPinned := p.native.IsPinned()
	if next.ClickThrough && !wasPinned {
		if err := p.setPinned(true); err != nil {
			return next, err
		}
	}
	state, err := p.native.SetStealth(next, preserveFocus)
	if err != nil && next.ClickThrough && !wasPinned {
		_ = p.setPinned(false)
	}
	return state, err
}

// toggle performs a chord of the native listener and names what it did.
func (p *darwinClient) toggle(action nativemac.Action) (string, error) {
	// An update must stay visible and interactive. Quitting never comes here.
	if p.desktop.locked.Load() {
		return "", errors.New("Unavailable while an update is required")
	}
	switch action.Kind {
	case nativemac.ToggleClickThrough:
		next, err := p.native.State()
		if err != nil {
			return "", err
		}
		next.ClickThrough = !next.ClickThrough
		// The shortcut leaves keyboard focus and a minimized window as they are.
		if _, err = p.writeState(next, true); err != nil {
			return "", err
		}
		observed, err := p.native.State()
		if err != nil {
			return "", err
		}
		p.desktop.emit("sharecode:stealth-state", observed)
		if observed.ClickThrough {
			return "enabled", nil
		}
		return "disabled", nil
	case nativemac.ToggleVisibility:
		if p.native.ToggleVisibility() {
			return "shown", nil
		}
		return "hidden", nil
	case nativemac.ToggleAlwaysOnTop:
		pinned := !p.native.IsPinned()
		if err := p.setPinned(pinned); err != nil {
			return "", err
		}
		p.desktop.emit("sharecode:pin-state", pinned)
		if pinned {
			return "pinned", nil
		}
		return "unpinned", nil
	}
	return "", fmt.Errorf("Unknown shortcut %s", action)
}

func (p *darwinClient) move(dx, dy int) error {
	if p.desktop.locked.Load() {
		return nil
	}
	return p.native.Move(dx, dy)
}

// recoverWindow makes the window interactive again, and brings it back when it
// was unreachable: after the listener was lost, and when the app is reopened.
func (p *darwinClient) recoverWindow() error {
	previous := p.state()
	next := previous
	next.ClickThrough = false
	// Apply it even when a partial failure made the readback ambiguous.
	observed, err := p.writeState(next, false)
	if err != nil {
		return err
	}
	p.desktop.emit("sharecode:stealth-state", observed)
	if p.mainOpened.Load() && (previous.ClickThrough || p.window.IsMinimized()) {
		p.window.Restore()
		p.window.Show()
		p.desktop.focus()
	}
	return nil
}

// showMain shows the main window once both permissions are ready. The update
// page needs neither, and does not count as opening the client.
func (p *darwinClient) showMain() error {
	locked := p.desktop.locked.Load()
	if !locked {
		if !p.hotkey.Available() {
			return errors.New("Input Monitoring permission is required before opening ShareCode")
		}
		supported, granted, err := nativemac.RecordingPermission()
		if err != nil {
			return err
		}
		if supported && !granted {
			return errors.New("Screen Recording permission is required before opening ShareCode")
		}
	}
	p.window.Restore()
	p.window.Show()
	if !locked {
		p.mainOpened.Store(true)
	}
	if !p.state().ClickThrough {
		p.desktop.focus()
	}
	return nil
}

// reopen answers the app being opened again while it runs.
func (p *darwinClient) reopen() {
	if p.desktop.shutdownStarted.Load() {
		return
	}
	if err := p.recoverWindow(); err != nil {
		log.Printf("Reopen recovery: %v", err)
	}
	if p.showMain() == nil {
		return
	}
	var err error
	if p.hotkey.Available() {
		err = p.openGuide(false, true)
	} else {
		err = p.openGuide(false, false)
	}
	if err != nil {
		log.Printf("Reopen setup: %v", err)
	}
}

// openSettings opens one fixed pane of System Settings: no caller-provided
// URL and no shell. Opening it grants nothing.
var openSettings = func(url, name string) error {
	if err := exec.Command("/usr/bin/open", url).Run(); err != nil {
		return fmt.Errorf("Could not open %s settings", name)
	}
	return nil
}

// openGuide shows the permission guide at its Input Monitoring or Screen
// Recording step, opens that pane of System Settings and places the guide
// beside it, once.
func (p *darwinClient) openGuide(chinese, recording bool) error {
	guide := p.guide.Load()
	if guide != nil && !guide.IsDestroyed() {
		guide.Restore()
	} else {
		url, title := guideURL, "Permission setup"
		if recording {
			url += "?recording=1"
		}
		if chinese {
			title = "权限设置"
		}
		guide = mygo.NewWindow(mygo.WindowOptions{
			Title: title, URL: url, Width: 360, Height: 350, UseContentSize: true, Hidden: true,
			DisableResize: true, DisableMaximize: true, DisableMinimize: true, DisableFullScreen: true,
			AlwaysOnTop: true, Page: pageOptions,
		})
		// The page's <title> is the app's name; the guide keeps its own.
		guide.Page().OnPageTitleUpdated(func(event *mygo.TitleEvent) { event.PreventDefault() })
		closed := guide
		guide.OnClosed(func() { p.guide.CompareAndSwap(closed, nil) })
		p.guide.Store(guide)
	}
	if err := nativeEvent.EmitPage(guide.Page(), NativeEvent{Event: "sharecode:permission-step", Payload: recording}); err != nil {
		return err
	}
	guide.Show()
	guide.Focus()
	var err error
	if recording {
		err = openSettings(screenRecordingSettings, "Screen Recording")
	} else {
		err = openSettings(inputMonitoringSettings, "Input Monitoring")
	}
	if err != nil {
		return err
	}
	nativemac.TrackGuide(guide.NativeHandle())
	return nil
}

type application struct {
	Name    string  `json:"name"`
	Path    *string `json:"path"`
	CanDrag bool    `json:"canDrag"`
}

func currentBundle() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return nativemac.BundleForExecutable(executable)
}

// permissionCommand runs the commands both the main page and the permission
// guide may call. guide is the calling guide's window, nil for the main page.
func (p *darwinClient) permissionCommand(command string, args map[string]any, guide *mygo.Window) (any, bool, error) {
	language, _ := args["language"].(string)
	chinese := strings.HasPrefix(language, "zh")
	switch command {
	case "get_client_hotkey_status":
		return p.hotkey.Status(), true, nil
	case "request_client_hotkey_permission":
		p.hotkey.RequestPermission()
		return nil, true, nil
	case "open_client_hotkey_settings":
		return nil, true, openSettings(inputMonitoringSettings, "Input Monitoring")
	case "open_client_recording_settings":
		return nil, true, openSettings(screenRecordingSettings, "Screen Recording")
	case "open_client_hotkey_setup":
		return nil, true, p.openGuide(chinese, false)
	case "open_client_recording_setup":
		return nil, true, p.openGuide(chinese, true)
	case "test_client_hotkey":
		return nil, true, p.hotkey.Test()
	case "show_client_main":
		return nil, true, p.showMain()
	case "get_client_application":
		bundle := currentBundle()
		app := application{Name: applicationName, CanDrag: nativemac.CanDragBundle(bundle)}
		if bundle != "" {
			app.Name, app.Path = strings.TrimSuffix(filepath.Base(bundle), ".app"), &bundle
		}
		return app, true, nil
	case "client_screen_share":
		result, err := p.screenShare(args, guide != nil)
		return result, true, err
	}
	return nil, false, nil
}

func (p *darwinClient) screenShare(args map[string]any, fromGuide bool) (any, error) {
	name, _ := args["action"].(string)
	action, known := map[string]int{
		"status": nativemac.ShareStatus, "refresh": nativemac.ShareRefresh, "start": nativemac.ShareStart,
		"stop": nativemac.ShareStop, "settings": nativemac.ShareSettings,
	}[name]
	if !known {
		return nil, errors.New("Unknown screen sharing action")
	}
	if fromGuide && action != nativemac.ShareStatus {
		return nil, errors.New("Screen sharing controls are only available in the main window")
	}
	if (action == nativemac.ShareRefresh || action == nativemac.ShareStart) && p.desktop.locked.Load() {
		return nil, errors.New("Screen sharing is unavailable while an update is required")
	}
	display, _ := args["displayId"].(float64)
	language, _ := args["language"].(string)
	return nativemac.ScreenShare(action, uint32(display), strings.HasPrefix(language, "zh"))
}

func (p *darwinClient) invoke(command string, args map[string]any) (any, error) {
	if result, handled, err := p.permissionCommand(command, args, nil); handled {
		return result, err
	}
	switch command {
	case "get_stealth_state":
		return p.native.State()
	case "set_stealth_state":
		click, err := boolArg(args, "clickThrough")
		if err != nil {
			return nil, err
		}
		capture, err := boolArg(args, "screenCaptureProtection")
		if err != nil {
			return nil, err
		}
		hidden, err := boolArg(args, "hideFromTaskbar")
		if err != nil {
			return nil, err
		}
		// A setting of the page must not overwrite a shortcut's newer native state:
		// only the changed switch applies. At launch the saved appearance and
		// privacy are restored, never click-through.
		next := nativemac.StealthState{ScreenCaptureProtection: capture, HideFromTaskbar: hidden}
		if field, changed := args["changedField"].(string); changed {
			if next, err = p.native.State(); err != nil {
				return nil, err
			}
			switch field {
			case "clickThrough":
				next.ClickThrough = click
			case "screenCaptureProtection":
				next.ScreenCaptureProtection = capture
			case "hideFromTaskbar":
				next.HideFromTaskbar = hidden
			default:
				return nil, errors.New("Unknown window setting")
			}
		}
		return p.writeState(next, false)
	case "client_set_pinned":
		pinned, err := boolArg(args, "pinned")
		if err != nil {
			return nil, err
		}
		return nil, p.setPinned(pinned)
	}
	return nil, fmt.Errorf("Unknown macOS command %q", command)
}

// guestInvoke runs a command of the permission guide, the only other page.
func (p *darwinClient) guestInvoke(page *mygo.Page, command string, args map[string]any) (result any, err error) {
	mygo.RunOnMain(func() {
		guide := p.guide.Load()
		if guide == nil || guide.IsDestroyed() || guide.Page() != page {
			err = errors.New("Desktop commands are for the client's own pages")
			return
		}
		switch command {
		case "client_window_close":
			guide.Close()
			return
		case "drag_client_application":
			bundle := currentBundle()
			if !nativemac.CanDragBundle(bundle) {
				err = errors.New("Open the installed app from Applications before setting up Input Monitoring")
				return
			}
			// No caller-supplied path; the running app is never moved or deleted.
			err = nativemac.DragApplication(guide.NativeHandle(), bundle)
			return
		}
		var handled bool
		if result, handled, err = p.permissionCommand(command, args, guide); !handled {
			err = fmt.Errorf("%q is unavailable in the setup window", command)
		}
	})
	return
}

func (p *darwinClient) meeting(string, map[string]any) (any, error) { return nil, errWindowsOnly }

func (p *darwinClient) lock() error {
	state, err := p.native.State()
	if err != nil {
		return err
	}
	if !state.ClickThrough {
		return nil
	}
	state.ClickThrough = false
	observed, err := p.native.SetStealth(state, false)
	if err == nil {
		p.desktop.emit("sharecode:stealth-state", observed)
	}
	return err
}

// gateChanged follows the mandatory-update gate. Locked, nothing of a room
// keeps running behind the update page, which needs no permission to show.
// Unlocked, the window goes back behind the permission guide if that is where
// the launch was.
func (p *darwinClient) gateChanged(locked bool) {
	if locked {
		nativemac.StopScreenShare()
		p.window.Restore()
	} else if !p.mainOpened.Load() {
		p.window.Hide()
	}
}

func (p *darwinClient) stopFeatures() error { return nil }

func (p *darwinClient) backgroundClose() error {
	p.hotkey.Stop()
	mygo.RunOnMain(nativemac.StopScreenShare)
	return nil
}

func (p *darwinClient) close() {
	nativemac.StopScreenShare()
	if guide := p.guide.Load(); guide != nil && !guide.IsDestroyed() {
		guide.Destroy()
	}
}
