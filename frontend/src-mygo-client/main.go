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

func main() {
	mygo.App.SetName(applicationName)
	mygo.App.SetVersion(applicationVersion)
	mygo.App.SetMenu(nil)
	frontend := assets.Files()
	if dir := os.Getenv("SHARECODE_MYGO_FRONTEND"); dir != "" {
		frontend = os.DirFS(dir)
	}
	// The page keeps the Tauri client's origin (http://tauri.localhost on
	// Windows): the server allows it, and saved sessions are stored under it.
	if err := mygo.Protocol.Handle("tauri", mygo.FileServer(frontend)); err != nil {
		log.Fatal(err)
	}
	if err := useInstalledProfile(); err != nil {
		log.Fatal(err)
	}
	desktop := &Desktop{}
	mygo.Bind(desktop)
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
		if desktop.main != nil {
			desktop.main.Show()
			desktop.focus()
		}
	})
	mygo.App.WhenReady(func() {
		if _, err := fs.Stat(frontend, "client.html"); err != nil {
			log.Fatal("The customer frontend is not built: run build-windows.ps1")
		}
		view, err := clientview.New(mygo.WindowOptions{
			Title: "ShareCode", URL: "tauri://localhost/client.html", Width: 1100, Height: 760,
			MinWidth: 480, MinHeight: 360, Hidden: true, Frameless: true, CornerRadius: 10,
			DisableFullScreen: true, SkipTaskbar: true,
		})
		if err != nil {
			log.Fatalf("Client window: %v", err)
		}
		w := view.Window
		desktop.main, desktop.view = w, view
		desktop.platform, err = attachPlatform(desktop, w)
		if err != nil {
			log.Printf("Native client: %v", err)
		}
		// A reloaded page starts over, like a launch: interactive, no update found yet.
		view.Page().OnDidNavigate(func(string) {
			desktop.locked.Store(false)
			go desktop.updates.closeAll()
			if desktop.platform != nil {
				if err := desktop.platform.lock(); err != nil {
					log.Printf("Navigation: %v", err)
				}
			}
		})
		w.OnResize(func() {
			bounds := w.Bounds()
			desktop.emit("tauri://resize", map[string]int{"width": bounds.Width, "height": bounds.Height})
		})
		view.Page().OnDOMReady(w.Show)
		w.OnClose(func(event *mygo.CloseEvent) {
			if !desktop.shutdownReady.Load() {
				event.PreventDefault()
				mygo.App.Quit()
				return
			}
			// Styles and hooks detach before the window is destroyed.
			if desktop.platform != nil {
				desktop.platform.close()
			}
		})
		w.OnClosed(mygo.App.Quit)
	})
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
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
	if d.view == nil || mygo.CallerPage(ctx) != d.view.Page() {
		return nil, errors.New("Desktop commands are for the client page")
	}
	if d.shutdownStarted.Load() {
		return nil, errors.New("The client is closing")
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
