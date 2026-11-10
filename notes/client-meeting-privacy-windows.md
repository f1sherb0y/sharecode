# Windows meeting-window capture exclusion

## Scope

The user selected application-wide filtering on 2026-11-10: while the switch is
on, protect all WeMeet/VooV top-level windows, including the main UI, dialogs,
toolbars and sharing borders. There is no longer a "currently sharing" gate,
window-title rule, Qt-version rule, topmost requirement, or monitor-size rule.
Taskbar entries are hidden locally too. Switching off restores saved values.

## Version audit

Downloaded these **seven packages / six versions** directly from Tencent's CDN,
using the Windows Package Manager repository's installer manifests. Every
download matched its manifest SHA-256 and had a Valid Authenticode signature from
Tencent Technology (Shenzhen). Extracted with 7-Zip 24.09; no meeting installer
was executed and the user's installed meeting application was not replaced.

| Product | Version | Architecture | Static observations |
| --- | --- | --- | --- |
| Tencent Meeting | 2.17.7.400 | x86 | `wemeetapp.exe`, `ui_kit.dll`, XTML/`share_tracker` resources; neither old exact `screen_share_tracker` nor `screen_share_float_container` literal found |
| Tencent Meeting | 3.20.5.478 | x86 | `wemeetapp.exe`, Qt5 alongside old UI/NX libraries; `screen_share_toolbar_window` |
| Tencent Meeting | 3.48.0.443 | x86 | `WeMeetApp.exe`, Qt6, Qt sharing identifiers and native `ScreenShareTrackerWindow` |
| Tencent Meeting | 3.48.0.443 | x64 | Same families as x86; also confirmed in the running installed version |
| VooV Meeting | 2.12.5.520 | x86 | `voovmeetingapp.exe`, `ui_kit.dll`, XTML/`share_tracker` resources; neither old exact marker literal found |
| VooV Meeting | 3.23.2.510 | x86 | `voovmeetingapp.exe`, Qt5/old UI/NX libraries; `screen_share_toolbar_window` |
| VooV Meeting | 3.43.0.510 | x86 | `VooVMeetingApp.exe`, Qt6, `screen_share_tracker` / `screen_share_float_container`; native `ScreenShareTrackerWindow` literal not found |

The machine-readable [audit](client-meeting-privacy-versions.json) records the
download URLs, hashes, signatures, PE executable architectures, and which
extracted binaries contain each searched ASCII/UTF-16 literal. **Binary strings
are evidence of implementation differences, not proof that each literal is a
runtime Win32 class or that every version has been exercised in a live meeting.**
This is a representative sample, not all released versions.

Manifest sources:
[Tencent Meeting](https://github.com/microsoft/winget-pkgs/tree/master/manifests/t/Tencent/TencentMeeting)
and [VooV Meeting](https://github.com/microsoft/winget-pkgs/tree/master/manifests/t/Tencent/VooVMeeting).
Publisher download pages:
[Tencent Meeting](https://meeting.tencent.com/download-center.html),
[VooV Meeting](https://voovmeeting.com/download-center.html).

## Confirmed original defects

1. In the running Tencent Meeting 3.48.0.443, the screen border is a visible,
   empty-title `ScreenShareTrackerWindow`, covering `(0,0)-(2560,1600)`.
   Both the former marker and overlay classifiers required a `Qt*` class.
   The border was never selected, even when another window activated filtering.
2. Sampling only once a second left a discovery gap after window creation.
   A momentarily hidden marker could also deactivate filtering and restore all
   protection in that process.
3. The previous hook had the client's architecture. Its explicit architecture
   mismatch check refused x86 meeting processes when ShareCode was x64. All
   sampled VooV packages and older Tencent Meeting packages use x86 application
   executables (verified from extracted PE headers, not installer architecture).

## Implementation

- `native/meeting_identity.rs` is shared by enumeration and the injected command
  handler. It recognizes the sampled main executable names (including update
  staging names), plus helpers nested within an installation containing one of
  those main images. The search is bounded to four ancestor directories; it does
  not match every Tencent process or generic helper executable elsewhere.
  This is executable-path identity, **not publisher authentication**. Runtime
  Authenticode verification was not added; audit signature checks refer to the
  downloaded packages only.
- Enumerate top-level HWNDs and resolve their owning process through
  `GetWindowThreadProcessId` / `QueryFullProcessImageNameW`. No captions are read
  for production matching. Owned popups and initially hidden windows are covered.
- `SetWinEventHook`, out of process, observes create/destroy/show/hide; a message
  pump drains/coalesces notifications at 20 ms intervals. A one-second sweep
  repairs missed notifications and application resets. The callback queues only
  PIDs, at most 256; it does not change windows or process arbitrary input events.
- x86 and x64 helper hosts each carry the matching DLL. The host validates the
  DLL against its embedded bytes, installs a thread-specific `WH_CALLWNDPROC`
  hook for one command, sends a bounded message, removes the hook and verifies
  readback. A hook is never kept installed between requests. There is no global
  injected hook, process patching, elevation, keyboard monitoring or network use.
  Both hosts and DLLs statically link the CRT, so an x64 client does not require
  a separately installed x86 Visual C++ runtime to control an x86 meeting app.
- Both display affinity and taskbar-style writes run on the owning thread.
  Cross-process synchronous style writes could otherwise hang on an unresponsive
  meeting UI. A failed thread is skipped for the rest of that sweep; other
  processes/threads continue. Hosts have bounded reply waits; timeout channels
  are discarded so a delayed response cannot satisfy a later request. Hosts exit
  on parent stdin EOF, and are terminated on normal teardown.
- Recheck PID/thread ownership before changes and verify capture/style values.
  Original affinity (including an initial 17) and only the taskbar style bits are
  stored on the HWND. Destroyed/recreated windows do not inherit those properties.
  Capture and taskbar restoration are independent. Changes an external actor
  makes after our settings are preserved when switching off.
- Invisible sandbox housekeeping windows can refuse modification. They are
  retried on the next sweep/show; a failed **visible** window makes status partial.
  Active status counts successfully protected visible windows, not every HWND
  in a process. This avoids treating an inaccessible, non-displayed renderer
  helper as a failure to protect otherwise successfully excluded visible UI.

Microsoft references:
[SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook),
[SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity).
Notifications are asynchronous: this reduces the discovery gap but does **not**
prove zero exposed frames when a new window is first shown. Capture exclusion
requires an honoring capture path and Windows 10 2004+ for exclusion semantics;
it is not a guarantee against every recorder. Unsupported native architectures,
elevated/sandboxed visible windows or rejected hooks are reported, not bypassed.

## Validation

`frontend/scripts/test-meeting-privacy-windows.ps1` builds isolated off-screen
Win32 fixtures for x86 and x64, then runs production enumeration, host/DLL IPC,
WinEvent delivery, affinity/style modification and restoration. It scopes all
writes to fixture PIDs and uses a separate instance mutex. It does not modify the
real meeting windows or require login/capture permission.

Cases include empty and arbitrary titles; native, Qt and unknown future classes;
normal and topmost windows; owned popups; hidden-before-first-show; title changes;
hide/show; destroyed/recreated HWNDs; x86 VooV and x64 WeMeet identities together;
an installation-contained helper; an unrelated application with identical window
classes; property resets; original affinity 0/1/17; external changes; an
unresponsive UI thread; helper-process crashes; stale PID ownership; and process
exit during filtering.

The explicit `live_meeting_roundtrip` ignored test takes
`SHARECODE_MEETING_LIVE_PIDS`, temporarily applies settings to only those PIDs,
reads values, and restores them (also via a cleanup guard on assertion failure).
It refuses to interfere with windows already managed by a running client.
On 2026-11-10, the user's running Tencent Meeting 3.48.0.443 x64 had **9 visible
windows successfully excluded, including the native border, and 2 taskbar
entries hidden**. The warm-helper apply took 35 ms. All original capture and
taskbar values were restored and verified. Two invisible HWNDs in a sandboxed
renderer refused changes; no visible window was unprotected.

This verifies native API readback and restoration, **not the remote participant's
received frames**. The other downloaded versions were statically analyzed only;
live acceptance across those versions, monitor changes and third-party capture
implementations remains separate work.

Windows builds now require both MSVC targets:
`rustup target add i686-pc-windows-msvc x86_64-pc-windows-msvc`.
The Windows release workflow installs them before building.
