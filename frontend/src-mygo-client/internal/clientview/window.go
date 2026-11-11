// Package clientview hosts the unchanged customer page in MyGo's native
// transparent surface. Unlike a standalone windowed WebView, the embedded
// WebView participates in the surface's DirectComposition alpha tree on Windows.
package clientview

import (
	"errors"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

// View keeps the native owner and the actual IPC/event page distinct.
type View struct {
	Window  *mygo.Window
	WebView *mygo.WebView
}

// New uses the same transparent native root as Pebbles, with the existing web
// frontend filling that root. Tests and the shipped host share this constructor.
func New(opts mygo.WindowOptions) (*View, error) {
	if opts.Content != nil {
		return nil, errors.New("clientview owns its transparent native content")
	}
	url, page := opts.URL, opts.Page
	opts.URL = ""
	opts.Page = mygo.PageOptions{}
	opts.Transparent = true
	opts.BackgroundColor = "#00000000"
	opts.DisableShadow = true
	result := &View{}
	opts.Content = ui.View(func(c *ui.Context) {
		c.Root().Background(ui.Transparent)
		if result.WebView != nil {
			ui.WebView(c, result.WebView).Fill()
		}
	})
	result.Window = mygo.NewWindow(opts)
	view, err := result.Window.NewWebView(mygo.WebViewOptions{
		URL: url, Page: page, Transparent: true, BackgroundColor: "#00000000",
	})
	if err != nil {
		result.Window.Destroy()
		return nil, err
	}
	result.WebView = view
	result.Window.Invalidate()
	return result, nil
}

func (v *View) Page() *mygo.Page { return v.WebView.Page() }
