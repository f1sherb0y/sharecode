// Package assets embeds the customer frontend that build-windows.ps1 copies
// into web/ (the Vite build of vite.client-mygo.config.ts).
package assets

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var embedded embed.FS

func Files() fs.FS {
	files, err := fs.Sub(embedded, "web")
	if err != nil {
		panic(err)
	}
	return files
}
