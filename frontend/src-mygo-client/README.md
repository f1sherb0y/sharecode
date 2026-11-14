# ShareCode customer client on MyGo (Windows and macOS)

The customer desktop client with a Go host on [MyGo](https://github.com/egoist/mygo)
instead of Tauri. The page is the same React client (`frontend/src/client`); only
its native side changes. The Tauri client (`src-tauri-client`) is still what is
released; its Swift and its Windows helper sources are built from there.

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

On macOS:

```sh
./build-macos.sh                                # development client
./build-macos.sh --release --version 0.2.8      # the released client, as a disk image
./build-macos.sh --release --version 0.2.8 --signed-updates   # and its signed update
./test-macos.sh                                 # every test; build first
```

The app is in `build/mygo-client/darwin-universal/`, a release's disk image in
`build/macos-dist/`. Needs Go 1.27, Bun, Xcode's command line tools (`swiftc`) and
the fixed signing certificate (`~/.tauri/sharecode-macos/`, see `BUILD.md`); both
builds are universal and signed with it, so a rebuilt app keeps its Input
Monitoring and Screen Recording. `--adhoc` builds a development client without
the certificate. `--signed-updates` needs `TAURI_SIGNING_PRIVATE_KEY`.

The released build is the Tauri client's app in every way macOS and an installed
client can tell: `ShareCode Client.app`, `Contents/MacOS/sharecode-client`,
`dev.sharecode.client`, the same designated requirement. An installed Tauri
client replaces its bundle's contents and runs that executable again, and macOS
ties the permissions to the requirement. macOS 12 is the oldest it runs on (Go's
and MyGo's limit; the Tauri client ran on 10.15).

## How it fits together

| Part | What it does |
| --- | --- |
| `main.go`, `update.go`, `platform_windows.go`, `platform_darwin.go` | The host: window, the page's commands, the update gate, shutdown |
| `internal/clientview` | A transparent native surface with the WebView inside it. A plain MyGo WebView window keeps an opaque backing, so room opacity would not show the desktop |
| `nativewin` | Windows integration, without MyGo: stealth styles and capture exclusion, pinning, the Alt+Shift shortcuts, meeting-window filtering |
| `nativemac` | macOS integration, without MyGo: the Option+Shift listener (a listen-only event tap, in Go) and the bindings of `libsharecode_native.dylib` |
| `nativemac/native`, `nativemac/build-native.sh` | The dylib: the Tauri client's Swift (capture, virtual display, pinning, guide placement) and `ClientWindow.swift`, which replaces its Rust around the window |
| `internal/updates` | Reads the update feed, verifies downloads, starts the installer (Windows) or replaces the app bundle (macOS) |
| `cmd/require-admin` | Windows: adds `requireAdministrator` to the built executable's manifest |
| `packaging` | The Inno Setup installer for Windows and its test; the macOS entitlements |
| `assets` | The embedded frontend (`assets/web`, copied in by the build) |

**The page.** `vite.client-mygo.config.ts` is the customer client's build with the
Tauri packages aliased to `src/lib/mygo-*.ts`, so no page code changes. Those
adapters call one Go method, `Desktop.Invoke(command, args)`, with the Tauri
client's command names, and receive every native event through one MyGo event,
`sharecode:native-event`, as `{event, payload}`. The build fails if a Tauri
runtime reaches the bundle.

**Origin and saved sessions.** The page is served from the `tauri://` scheme,
which WebView2 exposes as `http://tauri.localhost` and WebKit as
`tauri://localhost`: the origins the server already allows and the ones saved
sessions are stored under. On macOS WebKit keeps the default store by bundle
identifier, so the released build finds the Tauri client's with no step at all. The released build
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

## macOS

**No cgo.** MyGo calls AppKit through purego, and so does this: the Swift is a
universal dylib among the app's resources (`resources/darwin/`, built, not in
Git), signed with the app and loaded at launch. The hardened runtime would refuse
it, because a self-signed certificate has no team identifier, so the app carries
the `disable-library-validation` entitlement (`packaging/macos-entitlements.plist`).

**The window** is one of MyGo's nonactivating panels (`WindowOptions.Panel`), so
no class is swapped under WebKit as the Tauri client had to. `ClientWindow.swift`
replaces that class's `canBecomeKeyWindow` for this window (click-through must
also refuse the keyboard) and makes the unpinned window an ordinary one of a
single Space; `WindowPinning.swift` pins and unpins as before. It is never the
main window (MyGo's panels are not), which nothing here relies on.

**Shortcuts.** `nativemac/hotkey*.go` is `hotkey_macos.rs` in Go: a listen-only
session event tap on a thread of its own, the same phases, revisions, recovery
and 15-second test. The chords are also registered through
`mygo.GlobalShortcut` with empty handlers, only so that macOS absorbs them.
While an update is required the chords do nothing but quit, as on Windows (the
Tauri client only refused click-through).

**Permissions.** The main window stays hidden until Input Monitoring and Screen
Recording are ready; the guide is a second, opaque window on the same page
(`#/input-monitoring`) with its own short list of commands (`guestInvoke`). The
app bundle is dragged by `ClientWindow.swift`; its drag image is the app's own
icon.

**Updates.** The update is the `.app.tar.gz` of the feed. After the signature
check the archive is unpacked beside the installed app, the unpacked app's code
signature is verified, and two renames swap it in; where the folder is not the
user's to write, macOS asks for an administrator's password, as the Tauri updater
did. A detached `open` starts the app once the old process is gone.

## Not covered by the tests

The tests here never generate input and never touch a real meeting or an
installed client (the Windows suite above does generate input, on its test VMs).
Still to check by hand: what a remote participant sees in an actual shared
screen, and an update of an installed release build through the update feed
(development builds refuse to install updates).

The Windows installer and executable are not code-signed: the UAC prompt of each
names an unknown publisher.

On macOS the tests also never grant a permission, so they stop at the gate: they
cover the guide, the page's commands, the switches, pinning, moving, hiding and
the update gate, with real windows and the real page. Still to check by hand,
with a development client granted both permissions: the chords with real key
presses (click-through and back, hide, pin over another app's full screen, move,
opacity, quit), dragging the app into both permission lists, the shared display
in a meeting, an update installed by the client and its restart, and an update
from an installed Tauri client to a release build keeping both permissions.
