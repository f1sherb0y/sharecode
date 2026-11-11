# ShareCode customer client on MyGo (Windows)

The customer desktop client with a Go host on [MyGo](https://github.com/egoist/mygo)
instead of Tauri. The page is the same React client (`frontend/src/client`); only
its native side changes. macOS stays on the Tauri client (`src-tauri-client`).

## Build and test

```powershell
.\build-windows.ps1                           # development client
.\build-windows.ps1 -Release -Version 0.2.8   # the released client, with a signed update
.\test-windows.ps1                            # every test; build first
```

Both write to `build/mygo-client/` at the repository root: the executable under
`windows-amd64/` and the installer beside it. Nothing is installed or uploaded.

Needs Go 1.27, Bun with the frontend's dependencies installed, NSIS 3 (`-MakeNSIS`,
by default the copy Tauri downloaded) and `rustc` with the `x86_64-pc-windows-msvc`
and `i686-pc-windows-msvc` targets for the meeting helpers.

A development client has its own name, install directory and WebView2 profile, so
it runs beside a real installation and never installs updates. `-Release` builds
the real identity (`dev.sharecode.client`, `ShareCode Client`) and signs the
installer with `TAURI_SIGNING_PRIVATE_KEY`, the key installed clients already
trust; `cmd/sign-update` refuses any other key.

Run the tests from the focused terminal: Windows makes a window topmost only for
a process with foreground rights, so the pinning test skips in the background.

## How it fits together

| Part | What it does |
| --- | --- |
| `main.go`, `update.go`, `platform_windows.go` | The host: window, the page's commands, the update gate, shutdown |
| `internal/clientview` | A transparent native surface with the WebView inside it. A plain MyGo WebView window keeps an opaque backing, so room opacity would not show the desktop |
| `nativewin` | Windows integration, without MyGo: stealth styles and capture exclusion, pinning, the Alt+Shift shortcuts, meeting-window filtering |
| `internal/updates` | Reads the update feed, verifies downloads, starts the installer |
| `packaging` | The NSIS installer and its tests |
| `assets` | The embedded frontend (`assets/web`, copied in by the build) |

**The page.** `vite.client-mygo.config.ts` is the customer client's build with the
Tauri packages aliased to `src/lib/mygo-*.ts`, so no page code changes. Those
adapters call one Go method, `Desktop.Invoke(command, args)`, with the Tauri
client's command names, and receive every native event through one MyGo event,
`sharecode:native-event`, as `{event, payload}`. The build fails if a Tauri
runtime reaches the bundle.

**Origin and saved sessions.** The page is served from the `tauri://` scheme,
which WebView2 exposes as `http://tauri.localhost`: the origin the server
already allows and the one saved sessions are stored under. The released build
also opens the Tauri client's WebView2 profile in place
(`%LOCALAPPDATA%\dev.sharecode.client`), so the guest seat and settings carry
over with no migration step.

**Updates.** Mandatory, as in the Tauri client, and driven by the same page code:
check both nodes' `/api/client/update/...` feed, download, verify the minisign
signature against the client's key, then run the installer with `/P /R /UPDATE`
and quit; the installer restarts the client. The page holds the gate
(`set_client_update_locked`); while it is locked the host refuses click-through
and meeting filtering.

**Installer.** `packaging/installer.nsi` keeps the Tauri installer's registry key,
install directory and command line, so an installed Tauri client updates into
this one. MyGo's own installer has neither, which is why the build skips it.

**Meeting filtering.** The x86 and x64 helper executables and DLLs are built from
the Tauri client's sources (`src-tauri-client/native/meeting_window_*.rs`) by
`nativewin/build-helpers.ps1` and embedded in the executable.

## Not covered by the tests

The tests never generate input and never touch a real meeting or an installed
client. Still to check by hand: the shortcuts with real key presses, what a remote
participant sees in an actual shared screen, a machine without WebView2, and an
update from an installed Tauri client to a release build.
