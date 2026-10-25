# macOS native shortcut

The customer client uses a session-level `CGEventTap` with `listenOnly`; it never registers
`RegisterEventHotKey` on macOS. Windows is unchanged. Minimum macOS version: 10.15.

- Ctrl + Shift + physical F toggles click-through; Ctrl + Shift + physical Q quits via
  Tauri’s normal exit lifecycle. Q always quits, even when the F-only diagnostic test is armed.
  Both shortcuts accept left/right/mixed/generic modifiers. Caps Lock is ignored;
  Option/Command are excluded. Autorepeats and identical event delivery are ignored, without
  a debounce interval that could discard rapid consecutive presses. No ordinary keys/text are
  retained, logged, emitted or transmitted.
- The callback queues only recognized chords in a bounded channel. A separate run loop checks
  Input Monitoring, Secure Input, tap enablement and wake gaps. A watchdog notices stalled
  workers; recovery invalidates old queued actions and retries making the window interactive.
  A successful listener alone does not prove key delivery: use the physical-key test.
- All window changes run on the main thread, start from native readback and report their actual
  result. Setting a UI property merges only that property into the current native state.
- On macOS Ctrl+Shift+F never activates, resigns, focuses or restores a window. The same event
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
Input Monitoring** and an opaque setup window. This guide is shown once per WebView profile;
Window settings → Input Monitoring settings reopens it. The guide uses the running bundle's
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

When the listener is active, **Test shortcut** arms a 15-second test. The next Ctrl+Shift+F
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

Ctrl+Shift+Q uses the same listen-only event tap and permission as Ctrl+Shift+F. It calls normal
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
