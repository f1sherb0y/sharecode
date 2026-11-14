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

Needs Go 1.27, Bun with the frontend's dependencies installed, Inno Setup 6
(`-ISCC`, by default `Program Files (x86)\Inno Setup 6\ISCC.exe`) and `rustc` with
the `x86_64-pc-windows-msvc` and `i686-pc-windows-msvc` targets for the meeting
helpers.

A development client has its own name, install directory and WebView2 profile, so
it runs beside a real installation and never installs updates. `-Release` builds
the real identity (`dev.sharecode.client`, `ShareCode Client`) and signs the
installer with `TAURI_SIGNING_PRIVATE_KEY`, the key installed clients already
trust; `cmd/sign-update` refuses any other key.

Run the tests from the focused terminal: Windows makes a window topmost only for
a process with foreground rights, so the pinning test skips in the background.

**The client runs as administrator.** The build marks the executable
`requireAdministrator` (`cmd/require-admin` adds it to the manifest MyGo
embeds), so Windows asks for consent (UAC) at every start. The reason is the
keyboard hook: a low-level hook of a process that is not elevated receives no
keys while an elevated window has the focus (Task Manager, an installer, a
program started as administrator), and the shortcuts would do nothing there.
Elevated, the hook sees them. Because of that the client is installed under
Program Files and keeps what it starts there too (the meeting helpers, a
downloaded update): in the user's folders a process without administrator
rights could replace those files and have them run elevated. The Go tests run
test binaries without that manifest and never ask.

`RegisterHotKey` is called for the same chords only so that Windows absorbs
them; its `WM_HOTKEY` is ignored. Besides the hook, a poll of the keyboard
every 30 ms catches a chord the hook missed (Windows removes a hook that
answers too slowly). The hook is called before Windows updates what the poll
reads, so for 100 ms after a hook event the poll leaves that key alone:
otherwise it erased the key-down and acted on the held key a second time, and
a toggle switched and switched back.

## How it fits together

| Part | What it does |
| --- | --- |
| `main.go`, `update.go`, `platform_windows.go` | The host: window, the page's commands, the update gate, shutdown |
| `internal/clientview` | A transparent native surface with the WebView inside it. A plain MyGo WebView window keeps an opaque backing, so room opacity would not show the desktop |
| `nativewin` | Windows integration, without MyGo: stealth styles and capture exclusion, pinning, the Alt+Shift shortcuts, meeting-window filtering |
| `internal/updates` | Reads the update feed, verifies downloads, starts the installer |
| `cmd/require-admin` | Adds `requireAdministrator` to the built executable's manifest |
| `packaging` | The Inno Setup installer and its test |
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

**Updates.** Mandatory, as in the Tauri client, and driven by the same page code.
The client opens and checks in the background; a found update replaces the whole
page until it is installed: check both nodes' `/api/client/update/...` feed, download, verify the minisign
signature against the client's key, then run the installer with
`/SILENT /NORESTART /LAUNCH` and quit; the installer, elevated like the client
that started it, asks for nothing and starts the client again. The page locks the gate
(`set_client_update_locked`) when it finds an update; while it is locked the host
refuses click-through and meeting filtering.

**Installer.** `packaging/installer.iss` (Inno Setup 6; MyGo's own installer is
per user and leaves WebView2 alone, which is why the build skips it). It asks
for administrator rights once, installs under Program Files and closes a
running client through its main window. Before anything is installed it reads
the registered WebView2 runtime: none, or one older than Chromium 111 (the
page's CSS needs it; Windows 11 21H2 and 23H2 images carry 90 and 100), and
Microsoft's bootstrapper installs the current one for the machine, which only
an administrator can do over the runtime Windows came with. If that fails the
installer says so and installs nothing. `/SILENT /NORESTART /LAUNCH` is the
command line of the updater and of the one-line install command; `/LAUNCH`
(start the client afterwards) is the script's own switch. It shares nothing
with the Tauri client's NSIS installer: an installed Tauri client is not
updated in place, and a per-user Tauri installation stays beside this one
until it is uninstalled.

**Meeting filtering.** The x86 and x64 helper executables and DLLs are built from
the Tauri client's sources (`src-tauri-client/native/meeting_window_*.rs`) by
`nativewin/build-helpers.ps1` and embedded in the executable.

## Across Windows builds

`../scripts/windows-compat` installs the development client on the Hyper-V test
VMs (Windows 10 22H2, Windows 11 21H2 to 26H2) and checks it there with real
key presses and mouse clicks: the installer with its UAC prompt and WebView2
(absent on the Windows 10 image, too old on two Windows 11 images), the start
as administrator, the shortcuts (also with an elevated window in front),
click-through, pinning, transparency, capture exclusion, the title bar. See
its README.

## Not covered by the tests

The tests here never generate input and never touch a real meeting or an
installed client. Still to check by hand: what a remote participant sees in an
actual shared screen, and an update of an installed release build through the
update feed (development builds refuse to install updates).

The installer and the executable are not code-signed: the UAC prompt of each
names an unknown publisher.
