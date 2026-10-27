# macOS native shortcut

The customer client uses a session-level `CGEventTap` with `listenOnly`; it never registers
`RegisterEventHotKey` on macOS; Windows uses the same key map through its native keyboard hook. Minimum macOS version: 10.15.

- Option/Alt + Shift + physical H hides/shows; F toggles click-through; Q quits; T toggles pinning. Q quits via Tauri’s normal exit lifecycle. The 15-second diagnostic test consumes F only; H/Q/T remain active.
  Either Option and Shift side works, including mixed sides. Control/Command are excluded. Caps Lock is ignored. Autorepeats and identical event delivery are ignored, without
  a debounce interval that could discard rapid consecutive presses. No ordinary keys/text are
  retained, logged, emitted or transmitted.
- The callback queues only recognized chords in a bounded channel. A separate run loop checks
  Input Monitoring, Secure Input, tap enablement and wake gaps. A watchdog notices stalled
  workers; recovery invalidates old queued actions and retries making the window interactive.
  A successful listener alone does not prove key delivery: use the physical-key test.
- All window changes run on the main thread, start from native readback and report their actual
  result. Setting a UI property merges only that property into the current native state.
- On macOS Option+Shift+F never activates, resigns, focuses or restores a window. The same event
  tap receives the chord inside the app and in the background. An already-focused client keeps
  keyboard focus when pass-through is enabled (new mouse clicks pass through, and it cannot
  acquire focus again while pass-through is on). A minimized window stays minimized. The
  mouse-operated switch retains its explicit activation/handoff behavior; listener-loss recovery
  remains a separate safety action, not a shortcut side effect.
- One OS lock per app identifier prevents multiple copies from handling the same chord.
- Startup always leaves click-through off. When the listener is unavailable, enabling it is
  refused and a Dock-hidden window cannot be minimized from the title bar. Losing the listener
  turns click-through off and recovers a minimized window. Pinning stays as it was.

## Permission and diagnostic UI

On the first launch without permission, the client opens **System Settings → Privacy & Security →
Input Monitoring** and an opaque setup window. Next (or Later to skip this step) proceeds to
Screen Recording in the same window and opens that system settings page. The
`sharecode-macos-permission-setup-v1` progress marker survives an OS-requested restart; completed
permissions are skipped. Native permissions are rechecked on every launch, even after Done.
The macOS main window stays hidden until both are ready (Screen Recording on 12.3+).
Later closes the guide without opening the main window; reopening the app resumes setup.
Window settings → Input Monitoring settings reopens the first step; Shared screen → Recording
permission reopens the second step and its settings page. The guide uses the running bundle's
actual path/name, including an isolated test app's identity. Drag its icon into the system list,
then enable that app's switch. If it is already present, simply enable it. The **+** picker is
available as a fallback. Disk-image/translocated copies and unbundled development runs do not
allow dragging; install and open the app from Applications first.

The file drag is copy-only and carries a native file URL, not an HTML image. The helper has its
own window and minimal event/close capabilities: no room restore, update checks, opacity or
stealth initialization. Closing it does not close the room. Opening settings or completing a
drop is not treated as a permission grant. Only native listener status enables the test button.
Restart the installed app if macOS requests it. The existing **Enable Input Monitoring** button
still explicitly calls `CGRequestListenEventAccess`; the automatic guide never calls that API.
There is no Accessibility request or global-hotkey fallback.

When the listener is active, **Test shortcut** arms a 15-second test. The next Option+Shift+F
reports receipt without changing click-through. Timeout, window operation errors, listener
loss and Secure Input have distinct feedback. Secure Input and OS permissions can still block
delivery; this is not a promise to override macOS restrictions.

## Verification

Automated:

```sh
cargo test --locked --manifest-path frontend/src-tauri-client/Cargo.toml
cd frontend
bun run client:build
UI_BROWSER=chromium node --test tests/client-chrome.test.mjs
UI_BROWSER=firefox node --test tests/client-chrome.test.mjs
UI_BROWSER=webkit node --test tests/client-chrome.test.mjs
```

Use an isolated test identity (`dev.sharecode.client.hotkey-test`, `ShareCode Hotkey Test`,
`sharecode-hotkey-test`, updater endpoints empty) for native checks. Do not replace an installed
client or reuse its profile. No production version/tag/release is needed for this validation.

Manual macOS acceptance (still required on the installed test app):

1. Initially denied: the setup guide and Input Monitoring page open once, without an OS
   permission-request dialog. Click-through and hidden-Dock minimize remain disabled. Drag
   the actual test app into the list, manually grant or deny, then verify grant/relaunch. Close
   and reopen the guide from Window settings; no duplicate guide and no main-window changes.
2. Test left Ctrl/left Shift, left/right, right/left, right/right, both sides held and generic
   modifier input. Verify one action for a long hold and two actions for two quick presses.
3. Verify foreground/background, Chinese input, minimized and Dock-hidden windows; read the
   actual NSWindow focus/mouse state. The test button must not toggle the window.
4. With another program using the same registered shortcut, verify both apps can receive it.
5. Revoke permission, enable Secure Input, sleep/wake and lock/unlock; verify recovery to an
   interactive window and reattachment without replaying old presses or saved click-through.
6. Launch a second copy of the same identity; verify no second listener, then quit/relaunch to
   confirm its process lock is released. Test identities must remain independent.

## Local verification — 2026-10-26

- Six Rust tests passed (modifier sides/generic flags, repeat and duplicate handling,
  rapid presses, recovery, real OS instance locks, existing window geometry).
- Ten client UI tests passed in each of Chromium, Firefox and WebKit (30 total), including
  explicit permission gating, startup state, stale replies/events, in-app input focus and
  the smallest window's scrollable settings panel.
- Client TypeScript/Vite build and isolated macOS app build passed. The bundled app's ad-hoc
  signature verified. Its imports contain CGEventTap and Input Monitoring APIs, and no
  RegisterEventHotKey import.
- Launched the isolated app and checked its native UI: permission-required state, click-through
  and hidden-Dock minimization disabled, no automatic permission prompt, settings guidance
  visible. No permission was granted automatically.
- Actual chord delivery, NSWindow focus preservation, conflicting-app shortcuts, permission
  revocation and sleep/wake remain pending Input Monitoring approval and native acceptance.

References: [Apple listen-only taps and Input Monitoring](https://developer.apple.com/videos/play/wwdc2019/701/),
[CGEvent tap creation](https://developer.apple.com/documentation/coregraphics/cgevent/tapcreate(tap:place:options:eventsofinterest:callback:userinfo:)).

## Diagnostics and quit shortcut — 2026-10-26

The test app initially reported `permissionRequired`; its standard output/error were sent to
`/dev/null`, so stderr-only diagnostics were unavailable. The user enabled Input Monitoring
for the exact test app and confirmed the shortcut fully works. This resolves the reported
failure as a permission issue; it is not an independently completed sleep/wake acceptance test.

Native diagnostics now persist in the app-specific log directory:
`~/Library/Logs/dev.sharecode.client.hotkey-test/macos-hotkey.jsonl` for the test build.
The installed client uses its own bundle identifier. Records include launch identity, permission
and Secure Input state, listener transitions, 30-second health snapshots, recognized shortcut
actions/results, discarded stale actions, recovery and shutdown. Two rotating files are bounded
to about 256 KiB each. No ordinary keystrokes, text or room content are recorded. All file I/O
runs outside the event-tap callback. Finder-launched apps keep these logs even without a terminal.

Option+Shift+Q uses the same listen-only event tap and permission as Option+Shift+F. It calls normal
Tauri exit (joining the native listener threads), without first focusing or restoring the window.
There is no alternate shortcut listener. Test the new build with Q inside/outside the app and
while click-through is on; reopening it starts with click-through off as before.

Verification of the quit/logging build: eight Rust tests and ten Chromium client UI tests passed;
TypeScript/Vite, the isolated native app bundle and strict ad-hoc signature verification passed.
On relaunch, persistent logs captured `permission: false`, `secureInput: false`, then
`permissionRequired`. The updated ad-hoc build needs Input Monitoring approval again; live Q
shutdown verification is pending that approval. Evidence is saved under `build/hotkey-debug/`.

## Drag-to-settings setup guide — 2026-10-26

- The fixed `Privacy_ListenEvent` system-settings URL opens **Input Monitoring** directly.
  Verified on this Mac: the System Settings window title was 输入监控, alongside the native
  setup helper. The helper's button and Window settings entry reuse this destination.
- Native drag uses `drag` 2.1.1 on macOS only, with a fixed running-app path and copy mode.
  No filesystem path or destination URL is accepted from the WebView.
- Ten Rust tests passed, including app-bundle identity/path checks. Thirteen client UI tests
  passed in each of Chromium, Firefox and WebKit (39 total): one-time startup, manual reopen,
  drag gesture, no automatic permission request, readiness gates, failures and Chinese layout.
- TypeScript/client production build, isolated debug `.app` build and strict ad-hoc signature
  verification passed. Test identity: `dev.sharecode.client.setup-test`, ShareCode Setup Test.
  Its updater endpoints are empty. No production installation, version bump or publication.
- Native UI inspection confirmed the guide and direct settings page. After restart, native
  logs reported `permission: true`, `phase: listening`, `ready: true`. The user confirmed
  that dragging into the list and the test button both work. Automated UI input did not
  independently verify a physical chord; that is not implied by the browser mock tests.
- Updated SVG and 1×/2× PNGs: 720 × 660 / 1440 × 1320. A layout-only DMG using an existing
  app bundle passed `hdiutil verify` and mounted Finder metadata checks (background alias,
  720 × 692 window, icon positions, visible contents). This is layout evidence, not a newly
  released installer. Logs: `/tmp/sharecode-input-monitoring-{chromium,firefox,webkit}.log`
  and `/tmp/sharecode-input-monitoring-native-build.log`.

## Sequential recording permission guide — 2026-10-26

The same compact 360×350 helper serves both steps; its URL records the active step so WebView reloads
also preserve it. No new app path can be supplied by the frontend. Screen Recording uses the
same native copy-only file drag and installed-copy guard. The helper can only read capture
status, never start capture. A successful drop or settings navigation never marks permission
granted; status comes from the native preflight check. macOS below 12.3 skips the second step.
The offline bilingual installation help describes both steps; the compact DMG background
only shows the drag instruction and first-launch hint.

Both steps use a compact card: step indicator, Settings shortcut, a prominent drag instruction
with a hand-drawn curved arrow pointing outward, away from the app icon, one enable/restart hint, native status
and footer actions. The arrow cannot intercept pointer events. English and Chinese normal states fit without scrolling;
exceptional errors can scroll. The opaque helper remains independently movable.

`PermissionPlacement.swift` reads System Settings' compositor bounds once, 0.6 seconds after
opening a permission step. It places the guide beside Settings, trying above/below or another
display when needed. There is no repeating position timer, so subsequent manual placement
is preserved. This needs no Accessibility or Screen Recording permission, and
never moves/resizes Settings. If no disjoint space exists (for example, full-screen Settings on
a single display), it uses the on-screen corner with least overlap instead. Geometry tests
cover all four sides, negative display coordinates, a second display and that fallback.

## Permission gate and installer polish — 2026-10-26

Resumed the interrupted 08:59 session's four requests. The installer background is now
720×420 (with a 1440×840 Retina image): drag instruction, two icons and the first-launch hint.
The guide's arrowhead is separated from the outward curve. Placement runs once per opened
permission step, with no recurring position updates.

The main window is initially hidden on macOS. Both launch and Finder reopen pass native
permission checks; saved `done` progress cannot bypass them or prevent a permitted launch.
Completing recording returns to Input Monitoring if that permission is still missing. Failed
native checks leave the guide open. Shortcut toggling/recovery cannot reveal the main window
before its first successful permission check; recovery after normal use remains available.

Verification: 10 Rust tests, Swift policy/placement tests and both architecture typechecks,
TypeScript/client production build, 4 i18n tests, and 23 UI tests in each of Chromium, Firefox
and WebKit passed. Native isolated app `dev.sharecode.client.permission-gate-test` confirmed
Input Monitoring denied and only the 360×350 guide visible; the 1100×761 main window stayed
hidden both on launch and on Finder reopen. The isolated app was then stopped. Permission
grants and real capture remain manual acceptance steps.

Universal candidate: `build/macos-dist/0.2.2-universal-manual.nqwi0A/`. Both CPU architectures,
ad-hoc signature, mounted app signature, DMG checksum and Finder layout verified. No version
bump, commit, tag or publication was performed.


## Pinning above other apps' native full-screen Spaces (2026-10-26)

`native/WindowPinning.swift` prepares only the hidden customer main window as a nonactivating
`NSPanel` before WebKit is attached and before its first show. `main_window_macos.rs` builds
the native window from the existing config, prepares it, then attaches an auto-resizing WebView
with the same label. This uses Tauri's macOS-only `unstable` child-WebView API; existing
WebviewWindow commands and IPC retain their labels. Other platforms keep normal creation.
The same Tauri-owned native object and delegate are retained.
The runtime panel class preserves Tao 0.34's `focusable` Boolean at the exact original offset,
plus its key/main eligibility and `sendEvent:` implementations (including background drag).
Conversion requires a direct NSWindow subclass with exactly that one Boolean ivar, equal
NSWindow/NSPanel base sizes, matching ivar offset and total instance size; an unexpected layout
fails instead of reinterpreting incompatible memory. The permission guide and shared output
are not converted. The panel style is installed once; toggling it on/off on a live window is
avoided because AppKit's nonactivation/keyboard behavior is sensitive to that transition.

The shared `set_pinned` path now uses this native controller on macOS for both the title-bar
button and automatic pinning before click-through. It sets the floating level, all-Spaces and
full-screen auxiliary collection flags, disallows full-screen tiling, and on macOS 13+ permits
joining other applications. Conflicting collection flags are removed. It saves the prior
collection behavior and level once, restores both on unpin, and verifies native state plus
unchanged key/main/application activation and minimized state. Failed updates roll back.
There is no activate/makeKey/orderFront call in a pin/unpin operation, no new global shortcut,
no periodic focus enforcement and no added Accessibility permission. Existing Dock visibility
remains independently controlled. `is_pinned` reads the actual panel, style, level and flags.

Live verification on macOS 26.6.2 used two separate application identities from
`bash frontend/scripts/build-fullscreen-pin-test-macos.sh`. The host entered an actual native
full-screen Space (`styleMask.fullScreen == true`). The overlay exercises the production
controller after converting a Tao-shaped NSWindow with a real focusable ivar and overrides.
Its `isOnActiveSpace == true`, visible occlusion state, and pinned level/flags were confirmed
while the other app remained frontmost/key. Pin/unpin restored the original flags and level;
repeated pin/unpin preserved the host's focus. Both Regular (Dock shown) and Accessory (Dock
hidden) policies passed. Click-through disabled mouse input and both key/main eligibility;
restoring interaction restored them. Clicking and typing `fullscreen input works` into the
overlay succeeded without taking the host out of its native full-screen Space. Reports are
local ignored artifacts in `build/fullscreen-pin-test/`. This is native integration evidence,
not just flag/type checks; other macOS versions, Stage Manager, multiple monitors and actual
Tauri WebView/IME interaction across fullscreen apps still need broader manual coverage.

Reproduction: launch the two built apps, put **Full-screen Test Host** into native full screen
using its green control, and inspect **ShareCode Pin Test** above it. The overlay accepts
`pin`, `unpin`, `accessory`, `regular`, `through`, `interactive`, `minimize`, `restore`, `quit`
through `/tmp/sharecode-fullscreen-pin-test/command`. Current state is written to `host.json`
and `overlay.json` there. These controls exist only in the separate native test executable,
not the production client. Close both test processes after use.

Reference: Apple's guidance distinguishes a nonactivating NSPanel from an ordinary NSWindow:
https://developer.apple.com/forums/thread/826308 . The test confirmed the panel was necessary;
flags and even a higher level on an ordinary NSWindow were insufficient. The floating level
(3) sufficed in this test, so production does not use the screen-saver level (1000).

### Real Tauri regression and fix (2026-10-27)

The installed client's log recorded all eight Option+Shift+F presses with a healthy event tap,
then failed the automatic pin operation before click-through. A local real Tauri/WebKit probe
reproduced the cause: attaching WebKit first wraps `TaoWindow` in `NSKVONotifying_TaoWindow`.
The safe native-layout guard correctly refused that observed subclass. Earlier synthetic
Tao-shaped tests had no WebKit and missed this lifecycle difference.

Staging native creation before WebKit also exposed a separate optimized-Swift failure:
`window as? NSPanel` after `object_setClass` reused the preceding negative type check.
The object had changed class, but installation returned false before setting the style.
After the layout-checked conversion we now reborrow the same pointer as NSPanel explicitly.
We do not remove observers, copy KVO internals, match an OS-generated class name, or toggle
nonactivation on an already-visible window. Runtime layout validation remains in place.

`bash frontend/scripts/test-pinning-macos.sh --visible` reproduces the old-order failure and
tests the production creation/controller paths with real WebKit IPC and optimized Swift.
It cycles pin/unpin and focus-preserving click-through while hidden, shown, focused, resized,
minimized/restored and in both Dock policies, then exits normally. The fixture uses
`dev.sharecode.pinning-probe`, bundled local HTML and no event tap or privacy permissions.
The standalone synthetic host/overlay is now compiled with `-O` as well.

The real Tauri probe also passed above a separate native full-screen host on macOS 26.6.2:
`--fullscreen-check` verified active-Space membership and visible occlusion while the host
remained frontmost/key, then exercised pin/click-through without changing focus. The host's
native full-screen style was read back before and after. Evidence: local build artifacts
`pinning-fullscreen-real-tauri.log` and `pinning-fullscreen-host.json`. Test processes exited;
no privacy permissions were requested. Actual physical shortcut delivery in the new packaged
client remains a manual acceptance check (the installed old client's tap already received it).

Native diagnostics include actual class/layout, style/collection flags, level, key/main/
activation/minimized state and the precise failure branch (including pre-rollback state).
The rotating hotkey log records initialization and the window before a recognized shortcut;
native failures include these diagnostics. No ordinary keys or window contents are logged.
