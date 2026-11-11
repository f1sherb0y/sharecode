//go:build windows && mygo_smoke

package nativewin

import (
	"github.com/egoist/mygo"
	"sync"
)

// Actual embedded WebViews have their own Page; using Window.Page silently
// addresses the native host instead. Keep test helpers honest for both modes.
var embeddedSmokeViews sync.Map

func pageForSmoke(w *mygo.Window) *mygo.Page {
	if value, ok := embeddedSmokeViews.Load(w.ID()); ok {
		return value.(*mygo.WebView).Page()
	}
	return w.Page()
}
func captureForSmoke(w *mygo.Window) ([]byte, error) {
	if value, ok := embeddedSmokeViews.Load(w.ID()); ok {
		return value.(*mygo.WebView).CapturePage()
	}
	return w.CapturePage()
}
