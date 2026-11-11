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
| `packaging` | The NSIS installer and its tests |
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
signature against the client's key, then run the installer with `/P /R /UPDATE`
and quit; the installer restarts the client. The page locks the gate
(`set_client_update_locked`) when it finds an update; while it is locked the host
refuses click-through and meeting filtering.

**Installer.** `packaging/installer.nsi` keeps the Tauri installer's registry key,
install directory and command line, so an installed Tauri client updates into
this one. MyGo's own installer has neither, which is why the build skips it.

**Meeting filtering.** The x86 and x64 helper executables and DLLs are built from
the Tauri client's sources (`src-tauri-client/native/meeting_window_*.rs`) by
`nativewin/build-helpers.ps1` and embedded in the executable.

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

The tests never generate input and never touch a real meeting or an installed
client. Still to check by hand: the shortcuts with real key presses, what a remote
participant sees in an actual shared screen, a machine without WebView2, and an
update from an installed Tauri client to a release build.

On macOS the tests also never grant a permission, so they stop at the gate: they
cover the guide, the page's commands, the switches, pinning, moving, hiding and
the update gate, with real windows and the real page. Still to check by hand,
with a development client granted both permissions: the chords with real key
presses (click-through and back, hide, pin over another app's full screen, move,
opacity, quit), dragging the app into both permission lists, the shared display
in a meeting, an update installed by the client and its restart, and an update
from an installed Tauri client to a release build keeping both permissions.
