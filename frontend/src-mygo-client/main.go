package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"sync/atomic"

	"github.com/egoist/mygo"
	"sharecode/client/assets"
	"sharecode/client/internal/clientview"
)

// NativeEvent carries every native event to the page in one declared MyGo
// event, under the event names of the Tauri client.
type NativeEvent struct {
	Event   string `json:"event"`
	Payload any    `json:"payload"`
}

var nativeEvent = mygo.NewEvent[NativeEvent]("sharecode:native-event")

// Desktop is the page's only IPC service: Desktop.Invoke(command, args) with
// the command names of the Tauri client (src/lib/mygo-core.ts).
type Desktop struct {
	main     *mygo.Window
	view     *clientview.View
	platform platformClient
	updates  updater
	// The mandatory-update gate. The page locks it once it finds an update; while
	// locked, the window stays interactive and click-through and meeting
	// filtering are refused.
	locked          atomic.Bool
	shutdownStarted atomic.Bool
	shutdownReady   atomic.Bool
}

// platformClient is the native side of the client window. invoke, lock and
// close run on the UI thread; the others wait for helper processes and must not.
type platformClient interface {
	invoke(command string, args map[string]any) (any, error)
	meeting(command string, args map[string]any) (any, error)
	// lock makes the window interactive again (click-through off).
	lock() error
	// stopFeatures turns meeting filtering off while the update gate is locked.
	stopFeatures() error
	// backgroundClose restores other applications' windows before exit.
	backgroundClose() error
	close()
}

// A platform with pages besides the main one (the macOS permission guide)
// answers their commands itself.
type guestPages interface {
	guestInvoke(page *mygo.Page, command string, args map[string]any) (any, error)
}

// A platform that reacts to the update gate itself, on the UI thread, after
// the window was made interactive and shown.
type updateGate interface{ gateChanged(locked bool) }

// A platform where opening the app again goes through its own checks.
type reopener interface{ reopen() }

func main() {
	mygo.App.SetName(applicationName)
	mygo.App.SetVersion(applicationVersion)
	mygo.App.SetMenu(nil)
	frontend := assets.Files()
	if dir := os.Getenv("SHARECODE_MYGO_FRONTEND"); dir != "" {
		frontend = os.DirFS(dir)
	}
	// The page keeps the Tauri client's origin (http://tauri.localhost on
	// Windows, tauri://localhost on macOS): the server allows it, and saved
	// sessions are stored under it.
	if err := mygo.Protocol.Handle("tauri", mygo.FileServer(frontend)); err != nil {
		log.Fatal(err)
	}
	if err := useInstalledProfile(); err != nil {
		log.Fatal(err)
	}
	desktop := &Desktop{}
	mygo.Bind(desktop)
	go clearUpdates()
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if !desktop.shutdownReady.Load() {
			event.PreventDefault()
			desktop.beginShutdown()
		}
	})
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.App.OnSecondInstance(func([]string, string) {
		mygo.RunOnMain(func() {
			if again, ok := desktop.platform.(reopener); ok {
				again.reopen()
			} else if desktop.main != nil {
				desktop.main.Show()
				desktop.focus()
			}
		})
	})
	mygo.App.WhenReady(func() {
		if err := desktop.open(frontend); err != nil {
			log.Fatal(err)
		}
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

const (
	windowWidth, windowHeight       = 1100, 760
	minWindowWidth, minWindowHeight = 480, 360
)

// initialSize is the size of a new window: its usual size, or the work area
// where that is smaller. On a 1366×768 screen 728 px are left above the
// taskbar; a centered 760 px window would open with its title bar cut off.
func initialSize(workArea mygo.Rectangle) (width, height int) {
	width, height = windowWidth, windowHeight
	if workArea.Width > 0 && workArea.Height > 0 {
		width = max(minWindowWidth, min(width, workArea.Width))
		height = max(minWindowHeight, min(height, workArea.Height))
	}
	return width, height
}

// pageOptions are the options of the client's pages. Tests give them a
// session of their own; the client uses the default one, where the saved guest
// seat and settings are.
var pageOptions mygo.PageOptions

// open creates the hidden client window with its page and attaches the native
// side. UI thread.
func (d *Desktop) open(frontend fs.FS) error {
	if _, err := fs.Stat(frontend, "client.html"); err != nil {
		return errors.New("The customer frontend is not built: run build-windows.ps1 or build-macos.sh")
	}
	width, height := initialSize(mygo.Screen.PrimaryDisplay().WorkArea)
	options := mygo.WindowOptions{
		Title: "ShareCode", URL: "tauri://localhost/client.html", Width: width, Height: height,
		MinWidth: minWindowWidth, MinHeight: minWindowHeight, Hidden: true, Frameless: true, CornerRadius: 10,
		DisableFullScreen: true, SkipTaskbar: true, Page: pageOptions,
	}
	platformWindowOptions(&options)
	view, err := clientview.New(options)
	if err != nil {
		return fmt.Errorf("Client window: %w", err)
	}
	w := view.Window
	d.main, d.view = w, view
	d.platform, err = attachPlatform(d, w)
	if err != nil {
		log.Printf("Native client: %v", err)
	}
	// A reloaded page starts over, like a launch: interactive, no update found yet.
	view.Page().OnDidNavigate(func(string) {
		d.locked.Store(false)
		go d.updates.closeAll()
		if d.platform != nil {
			if err := d.platform.lock(); err != nil {
				log.Printf("Navigation: %v", err)
			}
		}
	})
	w.OnResize(func() {
		bounds := w.Bounds()
		d.emit("tauri://resize", map[string]int{"width": bounds.Width, "height": bounds.Height})
	})
	// Without its native side the client is still a window to join from.
	if showWhenReady || d.platform == nil {
		view.Page().OnDOMReady(w.Show)
	}
	w.OnClose(func(event *mygo.CloseEvent) {
		if !d.shutdownReady.Load() {
			event.PreventDefault()
			mygo.App.Quit()
			return
		}
		// Styles and hooks detach before the window is destroyed.
		if d.platform != nil {
			d.platform.close()
		}
	})
	w.OnClosed(mygo.App.Quit)
	return nil
}

// beginShutdown makes the window interactive, then restores the meeting
// windows off the UI thread and quits once that is done.
func (d *Desktop) beginShutdown() { d.beginShutdownWith(mygo.App.Quit) }

func (d *Desktop) beginShutdownWith(quit func()) {
	if d.shutdownStarted.Swap(true) {
		return
	}
	d.locked.Store(true)
	platform := d.platform
	if platform != nil {
		if err := platform.lock(); err != nil {
			log.Printf("Shutdown: %v", err)
		}
	}
	go func() {
		d.updates.closeAll()
		if platform != nil {
			if err := platform.backgroundClose(); err != nil {
				log.Printf("Shutdown: %v", err)
			}
		}
		d.shutdownReady.Store(true)
		quit()
	}()
}

func (d *Desktop) focus() {
	d.main.Focus()
	d.view.WebView.Focus()
}

// emit sends a native event to the page (src/lib/mygo-event.ts).
func (d *Desktop) emit(event string, payload any) {
	if err := nativeEvent.EmitPage(d.view.Page(), NativeEvent{Event: event, Payload: payload}); err != nil {
		log.Printf("Native event %s: %v", event, err)
	}
}

// Invoke runs one command of the page. Window commands run on the UI thread;
// updates and meeting filtering wait for the network or helper processes.
func (d *Desktop) Invoke(ctx context.Context, command string, args map[string]any) (result any, err error) {
	caller := mygo.CallerPage(ctx)
	if d.view == nil || caller == nil {
		return nil, errors.New("Desktop commands are for the client page")
	}
	if d.shutdownStarted.Load() {
		return nil, errors.New("The client is closing")
	}
	if caller != d.view.Page() {
		if guests, ok := d.platform.(guestPages); ok {
			return guests.guestInvoke(caller, command, args)
		}
		return nil, errors.New("Desktop commands are for the client page")
	}
	if isUpdateCommand(command) {
		return d.updateCommand(ctx, command, args)
	}
	if command == "get_meeting_privacy_status" || command == "set_meeting_privacy_enabled" {
		if d.platform == nil {
			return nil, errors.New("Native client unavailable")
		}
		return d.platform.meeting(command, args)
	}
	mygo.RunOnMain(func() { result, err = d.windowCommand(command, args) })
	if err == nil && command == "set_client_update_locked" && d.locked.Load() && d.platform != nil {
		err = d.platform.stopFeatures()
	}
	return
}

func (d *Desktop) windowCommand(command string, args map[string]any) (any, error) {
	w := d.main
	if w.IsDestroyed() {
		return nil, errors.New("Client window is closed")
	}
	switch command {
	case "client_window_minimize":
		w.Minimize()
		return nil, nil
	case "client_window_toggle_maximize":
		w.ToggleMaximize()
		return nil, nil
	case "client_is_maximized":
		return w.IsMaximized(), nil
	case "client_window_close":
		w.Close()
		return nil, nil
	case "client_window_focus":
		d.focus()
		return nil, nil
	case "client_window_set_title":
		title, err := stringArg(args, "title")
		if err != nil {
			return nil, err
		}
		w.SetTitle(title)
		return nil, nil
	}
	if d.platform == nil {
		return nil, errors.New("Native client unavailable")
	}
	switch command {
	case "set_client_update_locked":
		locked, err := boolArg(args, "locked")
		if err != nil {
			return nil, err
		}
		d.locked.Store(locked)
		if locked {
			if err := d.platform.lock(); err != nil {
				return nil, err
			}
			w.Show()
			d.focus()
		}
		if gate, ok := d.platform.(updateGate); ok {
			gate.gateChanged(locked)
		}
		return nil, nil
	case "set_stealth_state":
		if click, _ := args["clickThrough"].(bool); click && d.locked.Load() {
			return nil, errors.New("Click-through is unavailable while an update is required")
		}
	}
	return d.platform.invoke(command, args)
}

func boolArg(args map[string]any, key string) (bool, error) {
	value, ok := args[key].(bool)
	if !ok {
		return false, fmt.Errorf("%s must be a boolean", key)
	}
	return value, nil
}

func stringArg(args map[string]any, key string) (string, error) {
	value, ok := args[key].(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	return value, nil
}
