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
  `packaging/installer.iss` posts `WM_CLOSE` only to the application's main window
  (class `MyGoWindow`).
- **Origin.** MyGo's default origin is not one the server allows. Registering the
  `tauri` scheme gives `http://tauri.localhost` in WebView2, the Tauri client's origin,
  so neither the server nor saved sessions change.
- **Topmost needs foreground rights.** `SetWindowPos(HWND_TOPMOST)` succeeds but does
  nothing for a process in the background (seen on Windows 11 build 26300). The client
  has those rights when its button is clicked or its registered hotkey fires; a test
  run in the background does not, so the pinning test skips there.

- **Shortcuts and elevated windows** (2026-11-14). A low-level keyboard hook of a
  process that is not elevated receives nothing while an elevated window has the
  focus (seen with Task Manager on Windows 10 19045 and Windows 11 26300): every
  shortcut was dead there. The client now runs as administrator
  (`requireAdministrator`, UAC at each start) and keeps the hook as its only
  listener.
- **A chord acting twice** (2026-11-14). Seen once in some 250 held-key sequences
  on the test VMs: three key-downs of an arrow moved the window four steps. The
  keyboard poll that backs the hook up read GetAsyncKeyState just after a hook
  event, which Windows delivers before it updates that state; the poll erased the
  key-down and the next one acted on the held key again. A toggle (H, F, T) hit this
  way switches and switches back, which looks like a shortcut that did nothing. The
  poll now leaves a key alone for 100 ms after a hook event (`keyState.reconcile`).
- **Old WebView2** (2026-11-14). With runtime 90 (Windows 11 21H2 image) nothing is
  drawn, with 100 (23H2 image) the page's background is fully transparent: the CSS
  needs Chromium 111. Microsoft's bootstrapper updates a machine-wide runtime only as
  administrator; without it exits with -2147219416 and no prompt.
- **Installer** (2026-11-14). Inno Setup instead of NSIS, administrator, Program
  Files, WebView2 installed or updated before the client. No compatibility with the
  Tauri client's installer was kept: a per-user Tauri installation is not replaced.

## Still to do before a release

- Manual checks listed at the end of the README (a real shared screen, an update of
  an installed release build through the feed).
- Decide what happens to installed Tauri 0.2.7 clients: their updater would run the
  new installer with `/P /R /UPDATE`, which it does not know (it opens as a wizard),
  and the per-user copy stays installed beside the new one. The saved guest seat is
  found again only when the elevated client runs as the same Windows account.
- The server's `install.ps1` passes the new installer's switches: deploy it with the
  first MyGo release, not before.
- Code signing: unsigned, each UAC prompt names an unknown publisher.
- CI: `.github/workflows/client-release.yml` still builds the Windows installer with
  Tauri.
