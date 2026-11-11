# Customer client on MyGo (Windows)

Branch `feature/mygo-desktop-client`, from 0.2.7. The Windows customer client gets a
Go/MyGo host (`frontend/src-mygo-client`); the page and the Tauri client are unchanged,
and macOS stays on Tauri. Layout, build and tests: `frontend/src-mygo-client/README.md`.

Not released: nothing has been installed over a real client, signed with the real key
or published.

## Findings worth keeping

- **Transparency.** A MyGo window that is itself a WebView (`WindowOptions.URL`) keeps
  an opaque backing on Windows whatever the page paints; page captures and DWM
  thumbnails still look transparent, so only a check against the real desktop shows
  it. A native transparent `Content` surface with an embedded WebView
  (`internal/clientview`, the way Pebbles does it) composes correctly.
- **Second close button.** Hiding from the taskbar makes the window a tool window, and
  DWM then draws a native close button over the page's own while `WS_SYSMENU` is set.
  `nativewin` removes that bit (`CustomWindowControls`).
- **Closing the app from the installer.** MyGo has a hidden top-level dispatch window
  (`MyGoApp`); sending it `WM_CLOSE` leaves the process running without an event loop.
  `packaging/installer.nsi` posts `WM_CLOSE` only to the application's main window
  (class `MyGoWindow`, or Tao's `Window Class` for an installed Tauri client).
- **Origin.** MyGo's default origin is not one the server allows. Registering the
  `tauri` scheme gives `http://tauri.localhost` in WebView2, the Tauri client's origin,
  so neither the server nor saved sessions change.
- **Topmost needs foreground rights.** `SetWindowPos(HWND_TOPMOST)` succeeds but does
  nothing for a process in the background (seen on Windows 11 build 26300). The client
  has those rights when its button is clicked or its registered hotkey fires; a test
  run in the background does not, so the pinning test skips there.

## Still to do before a release

- Manual checks listed at the end of the README (real key presses, a real shared
  screen, a machine without WebView2).
- An update from an installed Tauri 0.2.7 to a `-Release` build on a test machine,
  confirming the room reopens with the saved guest seat.
- CI: `.github/workflows/client-release.yml` still builds the Windows installer with
  Tauri.
