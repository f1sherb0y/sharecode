//go:build windows

package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/egoist/mygo"
	"sharecode/client/nativewin"
)

const showWhenReady = true

func platformWindowOptions(*mygo.WindowOptions) {}

type windowsClient struct {
	desktop   *Desktop
	native    *nativewin.Window
	monitor   *nativewin.MeetingMonitor
	featureMu sync.Mutex
}

func attachPlatform(d *Desktop, w *mygo.Window) (platformClient, error) {
	p := &windowsClient{desktop: d}
	var err error
	p.native, err = nativewin.Attach(w.NativeHandle(), nativewin.Options{
		Dispatch: mygo.RunOnMain, OnShortcut: p.shortcut,
		CustomWindowControls: true,
		OnError: func(err error) {
			log.Printf("Windows native client: %v", err)
			if p.native != nil {
				d.emit("sharecode:hotkey-status", p.native.HotkeyStatus())
			}
		},
		OnStealthChange:  func(state nativewin.StealthState) { d.emit("sharecode:stealth-state", state) },
		OnHotkeyStatus:   func(status nativewin.HotkeyStatus) { d.emit("sharecode:hotkey-status", status) },
		SetTaskbarHidden: func(hidden bool) error { w.SetSkipTaskbar(hidden); return nil },
	})
	if err != nil {
		return nil, err
	}
	if err = p.native.StartHotkeys(); err != nil {
		log.Printf("Windows hotkeys: %v", err)
	}
	// The helpers are unpacked beside the executable, under Program Files:
	// this process is elevated, and what it starts must not sit where a
	// process without administrator rights can replace it.
	executable, err := os.Executable()
	if err != nil {
		p.native.Close()
		return nil, err
	}
	p.monitor, err = nativewin.NewMeetingMonitor(nativewin.MeetingOptions{
		CacheDir: filepath.Join(filepath.Dir(executable), "meeting-helpers"),
		Assets:   nativewin.DefaultHelperAssets,
		OnStatus: func(status nativewin.MeetingStatus) { d.emit("sharecode:meeting-privacy", status) },
	})
	if err != nil {
		p.native.Close()
		return nil, err
	}
	return p, nil
}
func (p *windowsClient) invoke(command string, args map[string]any) (any, error) {
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
		return p.native.SetStealth(nativewin.StealthState{ClickThrough: click, ScreenCaptureProtection: capture, HideFromTaskbar: hidden})
	case "client_set_pinned":
		pinned, err := boolArg(args, "pinned")
		if err != nil {
			return nil, err
		}
		return nil, p.native.SetPinned(pinned)
	case "get_hotkey_status":
		return p.native.HotkeyStatus(), nil
	default:
		return nil, fmt.Errorf("Unknown Windows command %q", command)
	}
}
func (p *windowsClient) meeting(command string, args map[string]any) (any, error) {
	p.featureMu.Lock()
	defer p.featureMu.Unlock()
	if p.monitor == nil {
		return nil, errors.New("Meeting filtering is unavailable")
	}
	if command == "get_meeting_privacy_status" {
		return p.monitor.Status(), nil
	}
	enabled, err := boolArg(args, "enabled")
	if err != nil {
		return nil, err
	}
	if enabled && p.desktop.locked.Load() {
		return nil, errors.New("Meeting filtering is unavailable while an update is required")
	}
	return p.monitor.Enable(enabled)
}
func (p *windowsClient) lock() error {
	state, err := p.native.State()
	if err != nil {
		return err
	}
	state.ClickThrough = false
	_, err = p.native.SetStealth(state)
	return err
}
func (p *windowsClient) stopFeatures() error {
	p.featureMu.Lock()
	defer p.featureMu.Unlock()
	// A delayed old-document cleanup must not undo an already-unlocked new
	// document's explicit feature enable. Enable/disable shares featureMu.
	if !p.desktop.locked.Load() {
		return nil
	}
	if p.monitor == nil {
		return nil
	}
	_, err := p.monitor.Enable(false)
	return err
}
func (p *windowsClient) backgroundClose() error {
	p.featureMu.Lock()
	defer p.featureMu.Unlock()
	if p.monitor == nil {
		return nil
	}
	err := p.monitor.Close()
	p.monitor = nil
	return err
}
func (p *windowsClient) close() {
	if err := p.native.Close(); err != nil {
		log.Printf("Native window cleanup: %v", err)
	}
}
func (p *windowsClient) shortcut(action nativewin.Action) {
	var err error
	// Updates must remain visible and interactive. Quitting is always permitted.
	if p.desktop.locked.Load() && action != nativewin.Quit {
		return
	}
	switch action {
	case nativewin.Quit:
		mygo.App.Quit()
	case nativewin.Hide:
		_, err = p.native.ToggleVisibility()
	case nativewin.ClickThrough:
		var state nativewin.StealthState
		state, err = p.native.State()
		if err == nil {
			state.ClickThrough = !state.ClickThrough
			state, err = p.native.SetStealth(state)
		}
		if err == nil {
			p.desktop.emit("sharecode:stealth-state", state)
			if pinned, e := p.native.IsPinned(); e == nil {
				p.desktop.emit("sharecode:pin-state", pinned)
			}
		}
	case nativewin.Pin:
		var pinned bool
		pinned, err = p.native.IsPinned()
		if err == nil {
			pinned = !pinned
			err = p.native.SetPinned(pinned)
		}
		if err == nil {
			p.desktop.emit("sharecode:pin-state", pinned)
		}
	case nativewin.Left:
		err = p.native.Move(-1, 0)
	case nativewin.Right:
		err = p.native.Move(1, 0)
	case nativewin.Up:
		err = p.native.Move(0, -1)
	case nativewin.Down:
		err = p.native.Move(0, 1)
	case nativewin.OpacityDown:
		p.desktop.emit("sharecode:opacity-step", -1)
	case nativewin.OpacityUp:
		p.desktop.emit("sharecode:opacity-step", 1)
	}
	if err != nil {
		log.Printf("Native shortcut %s: %v", action, err)
	}
}
