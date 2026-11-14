package main

import (
	"os"
	"path/filepath"
)

// useInstalledProfile points the production build at the WebView2 profile of
// the Tauri client it replaces, %LOCALAPPDATA%\dev.sharecode.client, so the
// guest seat and settings carry over: invitations are single-use. The page is
// served from the same origin (see main). Other builds keep MyGo's own
// folder, named after the application. macOS needs no such step: WebKit keeps
// the default store by bundle identifier, which the released build shares.
func useInstalledProfile() error {
	if applicationID != productionID {
		return nil
	}
	local, err := os.UserCacheDir()
	if err != nil {
		return err
	}
	return os.Setenv("WEBVIEW2_USER_DATA_FOLDER", filepath.Join(local, productionID))
}
