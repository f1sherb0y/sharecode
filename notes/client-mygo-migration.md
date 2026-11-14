# Customer client on MyGo (Windows and macOS)

Branch `feature/mygo-desktop-client`, from 0.2.7, then `feature/go-backend`. The
customer client gets a Go/MyGo host (`frontend/src-mygo-client`) on Windows and,
since 2026-11-11, on macOS; the page and the Tauri client are unchanged. Layout,
build and tests: `frontend/src-mygo-client/README.md`.

Not released: nothing has been installed over a real client, signed with the real
updater key or published.

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

## macOS: what was run, and where

One Mac (Apple silicon, macOS 26.6.2), 2026-11-11.

- `test-macos.sh` passes: the unit tests (the chord, move, bundle and log tests
  are the Rust ones carried over; the listener's state machine has new ones), real MyGo panels read back from AppKit, and the real
  host with the real page up to the permission gate.
- The development app, signed with the fixed certificate under the hardened
  runtime, launches, loads the dylib, registers all ten chords, reports
  `permissionRequired`, opens the guide with the main window hidden, and quits
  cleanly on SIGTERM.
- A capture of the client's own window has alpha 0.65 where the page paints its
  background and 0 in the rounded corners: the transparent surface with an
  embedded WebView that Windows needs composes on macOS too.
- `build-macos.sh --release` makes `ShareCode Client.app` with
  `Contents/MacOS/sharecode-client`, and that app satisfies the designated
  requirement of the Tauri client installed on the same Mac (`codesign --verify
  -R`). An archive of a built app, installed over a copy by the update code,
  still verifies against the certificate.
- Not run: anything behind the two permissions (this session had no Input
  Monitoring, and nobody granted the development app any), a real update and
  restart, the release app itself (it would open the installed client's saved
  session), an Intel Mac, and macOS before 26.

## macOS findings worth keeping

- **A panel instead of a swapped class.** MyGo's `Panel` window is already a
  nonactivating `NSPanel`, created before WebKit observes it. By the time the
  host sees it its runtime class is `NSKVONotifying_MyGoPanel`, so the method is
  replaced on `MyGoPanel` itself, never on the object's class.
- **MyGo's level.** MyGo keeps its own record of whether a window floats and
  applies it whenever it sets a level; the host tells it about every pin
  (`SetAlwaysOnTop`) after the Swift has saved the unpinned state.
- **The restart of an installed Tauri client** runs
  `Contents/MacOS/sharecode-client` again. MyGo names the executable and the
  bundle after `name`, so the release is built as `sharecode-client` and the
  bundle renamed, which a signature does not cover.
- **MyGo's own signing** adds a secure timestamp and the hardened runtime for
  any identity but ad hoc. The build has MyGo sign ad hoc and signs with the
  certificate itself, inside out, as the Tauri build did (no timestamp).
- **The page restores its saved switches at launch**, after the host applied
  its defaults: a test that sets a switch in the first seconds loses to it.

## Still to do before a release

- macOS by hand: the list at the end of the README, on a development client
  granted both permissions, and an update from an installed Tauri client.
- Manual checks listed at the end of the README (a real shared screen, an update of
  an installed release build through the feed).
- Decide what happens to installed Tauri 0.2.7 clients: their updater would run the
  new installer with `/P /R /UPDATE`, which it does not know (it opens as a wizard),
  and the per-user copy stays installed beside the new one. The saved guest seat is
  found again only when the elevated client runs as the same Windows account.
- The server's `install.ps1` passes the new installer's switches: deploy it with the
  first MyGo release, not before.
- Code signing: unsigned, each UAC prompt names an unknown publisher.
- CI: since 0.2.8 `.github/workflows/client-release.yml` builds this client for a
  `client-v<version>` tag and uploads it to the draft. It builds nothing for macOS: `build-macos.sh` is not in
  CI yet.
