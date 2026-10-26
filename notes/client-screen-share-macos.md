# macOS filtered virtual display

## Per-window purple sharing controls (2026-10-26)

On macOS 14+, capture now uses bounded `SCScreenshotManager.captureSampleBuffer` calls
with the existing application allow-list. The resulting native sample buffers feed the same
virtual display/output layer. macOS 12.3–13 keeps SCStream (the title-bar controls arrived
with macOS 14). This changes the capture lifecycle, not the OS privacy settings: there is no
private indicator suppression, global preference, or weakening of the excluded-app policy.
The macOS recording/privacy indicator is outside this per-window UX fix.

Local controlled comparison on M2 / macOS 26.6.2, using an isolated signed capture app:

| Source method | Source title-bar purple control | Result |
| --- | --- | --- |
| SCStream application allow-list | Present | Reproduces the reported problem |
| SCStream window allow-list | Present | Not a fix |
| SCStream app allow-list + includeMenuBar | Present | Menu bar option is unrelated |
| SCStream display exclusions | Absent | Rejected: newly launched excluded PIDs are not fail-closed |
| SCScreenshotManager app allow-list | Absent | Preserves the fail-closed application set |

The screenshot test delivered 3,201 frames in about 107 seconds at 2560×1662
(29.92 fps), no errors and no magenta samples from the excluded synthetic app.
A separate 3840×2160 run delivered 2,080 frames in about 71 seconds (29.16 fps),
also without errors or excluded-magenta samples.
The production controller was then compiled directly into the fixture, creating a real
3320×2160 virtual display. Its output was recaptured once/sec for a local preview and numeric
checks. The synthetic source visibly updated; on a restart, all 58 sampled output frames had
different hashes and the excluded-magenta maximum was zero. Tencent Meeting was visibly
present on the physical source display and absent from the virtual-output preview. Its
application identity and a newly launched synthetic nested meeting helper were both excluded.
The synthetic source retained ordinary traffic-light buttons throughout production capture.
Stopping restored the online-display list to `[1]`; restarting created a fresh working output.
Revoking the fixture's recording grant during production capture caused a capture-permission
error, stopped the session, and removed the output display (`[1]` again). All three test
apps were then stopped and moved to Trash; ScreenCapture was reset again after exit and
System Settings verified that the test app no longer appeared. Production permissions and
the user's actual Tencent Meeting app were preserved.
Numeric evidence lives in ignored `build/capture-indicator-test/*.json` artifacts.

`ScreenshotCapture.swift` has one outstanding request maximum, including across stop/restart.
An allow-list revision discards old in-flight results. Stop removes the output immediately;
late frames/errors cannot revive it. A ten-second no-frame timeout ends a stalled screenshot
session; the API itself has no cancellation operation. Sampling is capped at 30 fps with
backpressure, so high resolutions or slower machines may run below that. Adaptive polling
uses 30 fps on changes, 15 fps after 250 ms quiet and 5 fps after one second quiet;
exact BGRA comparison runs asynchronously on Metal for both static and dynamic frames,
with an off-main-thread CPU fallback on GPU unavailability/failure. Idle detection adds up to a 200 ms polling
interval plus processing/scheduling latency. See `client-capture-adaptive-macos.md` for
the measured CPU reduction and memory/latency tradeoffs; `client-capture-gpu-macos.md`
covers the subsequent GPU implementation and its full-pipeline comparison. It does not silently
fall back to a stream that reintroduces the title-bar controls.

`frontend/scripts/test-screen-share-macos.sh` tests bounded requests, changed filters,
stop/restart, stale callbacks/errors and invalid frames using controlled completions, then
typechecks both CPU architectures. `frontend/scripts/capture-indicator-test/README.md`
describes the permissioned native experiment. Only this local OS/hardware was run; other
supported macOS releases are covered by availability checks, not a claim of live testing.

Apple references: [screenshot API](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
and [WWDC23 ScreenCaptureKit](https://developer.apple.com/videos/play/wwdc2023/10136/).

The title-bar **共享画面 / Shared screen** Popover selects a source display. Starting
creates a temporary extended display named **secondary monitor**, then fills it
with an opaque borderless output window. In the meeting app choose **share a
screen/display → secondary monitor**. The physical workspace stays available and
the output does not activate or take focus. Stopping removes both window and display.

## Virtual display and device compatibility

`native/VirtualDisplay.m` resolves the private CoreGraphics `CGVirtualDisplay*`
classes and required selectors at runtime. No root helper, installed driver,
Developer ID, trusted certificate or system security change is needed. Missing
API or failed modes produce an explicit error, not a physical-screen overlay.
The display object is owned by the process and disappears on release/process exit.
Private API remains an OS compatibility dependency; this is not an App Store API.
Interface reference: Chromium `ui/display/mac/test/virtual_display_util_mac.mm`.

Target hardware is M1 and newer MacBooks; ScreenCaptureKit still requires macOS
12.3+. M1 hardware running macOS 11 is not supported for this feature. Intel is
still compiled/typechecked, but not claimed as runtime-tested in this revision.

`VirtualOutputPreparation` negotiates at runtime, with no developer-machine model,
screen-size or display-ID constants. It generates source-aspect-preserving even
pixel modes bounded by 3840×2160, 2560×1440, 1920×1080 and 1280×720, deduplicating
and never upscaling small sources. Each candidate must appear in NSScreen and
CoreGraphics, match actual backing pixels, and accept extended-display placement.
Supported display modes are queried if WindowServer initially chooses another
scaled mode. Creation failure immediately tries the next mode; a candidate that
never becomes usable times out after five seconds. Exhaustion stops with an error.
The menu shows the actual output pixels, rather than claiming every machine got 4K.

HiDPI modes use half-sized logical dimensions with full-sized backing pixels;
refresh is 60 Hz, capture remains capped at 30 fps. Only our output is positioned,
to the right of the current desktop, with an application-lifetime configuration;
physical screen positions and the primary display are not changed by our code.
The output window covers the virtual display's full frame, including menu/Dock
areas, joins Spaces and cannot become key/main. Source selection excludes all
ShareCode-owned virtual displays by vendor/product identity, preventing recursive
capture across production and test instances. External monitors and unrelated
virtual displays can still be sources.

Expected display notifications from creating/releasing output do not stop startup.
Once running, removal, mirroring, source geometry/pixel changes or an output mode
change stop/clear the session. Permission revocation, lock, sleep, capture error,
Stop and process exit release the display. Stop during startup invalidates pending
enumerations and drops the preparation object too. No automatic restart after wake.

### Current verification boundary (2026-10-26)

Actual native testing on **Apple M2, macOS 26.6.2** used production display/window
classes and production mode negotiation, without recording/input permissions:
4K did not come online on this host and negotiated 2560×1440; 3024×1964 and
2560×1440 came online directly. Verified extended output, exact full-frame window
and backing pixels, preserved physical layout/primary screen/foreground app, repeated
creation/removal and cancellation during startup. Test displays were removed afterward.

Policy checks cover representative M1+ built-in panel dimensions, 4K/5K/6K external
screens, ultrawide, portrait and small scaled modes. These are sizing tests, **not**
claims of physical testing on those computers. Apple silicon and Intel are typechecked
with the 10.15 deployment target and the 12.3 runtime gate. Remaining hardware/OS
acceptance should include an M1 Air, 14/16-inch Pro, newer Air, macOS 12/13/14/15/26,
external displays, clamshell, wake, and Chrome/Zoom/Tencent screen selection. No live
meeting, production server or user's installed app is used by these tests.

Final validation for this revision: native policy/placement/adaptive-size tests;
arm64/x86_64 Swift and Objective-C compatibility checks; native display preparation,
backing pixels, cancellation and teardown; 10 Rust tests; TypeScript/Vite client
production build; 4 i18n tests; 3 Chromium share-popover cases. Universal app and
mounted DMG both passed the persistent-certificate/all-architectures verifier.
Candidate: `build/macos-dist/0.2.2-universal-manual.tJBU7j/`.
Build log: `build/virtual-display-build.log`. No installed client was replaced and
no release/server was modified. Live filtered capture and receiver screen selection
for this revision remain acceptance checks, distinct from the completed native
output lifecycle test.

## Capture and exclusions

Requires macOS 12.3+ (ScreenCaptureKit). The rest of the client retains its macOS 10.15 minimum.
Swift and the Objective-C virtual-display bridge are compiled into a static archive for the current Rust architecture by `build.rs`;
ScreenCaptureKit is weak-linked. Requires Xcode/Command Line Tools with the macOS 12.3+ SDK.
No added runtime installer, driver, extension, network service or recording file.

`src/client/screen-share.tsx` is mounted inside the title bar's existing Popover component,
using the Ghost menu's width, theme, opacity and control styles. No separate setup window,
route or capability is created. Dismissing the menu keeps capture active; reopening reads the
native state and selected display. `src/screen_share_macos.rs` restricts capture commands to
the main window (the permission helper may read status only) and dispatches them to the AppKit thread. Only status/display geometry cross
the Swift C bridge as owned JSON; the matching Swift free entry releases every response.
Frames never cross this bridge.

- `native/CapturePolicy.swift`: Tencent Meeting / VooV / WeMeet bundle families, exact normalized
  application names, nested helper bundle paths, production ShareCode bundle family and actual
  running bundle/PID. The native controller also rejects helpers inside its own app bundle.
  Window titles are never used as identity; no arbitrary caller-supplied exclusion list.
- `native/ScreenShare.swift`: ScreenCaptureKit **including-applications** filter over all
  discovered, non-excluded apps, with an empty exception list. Enumerates once per second.
  New processes cannot appear before identification, including meeting restarts. All windows
  owned by an excluded process stay out without individually tracking window creation.
  Unknown future helper identities must be added to the policy when discovered; actual Tencent
  and VooV versions still need integration testing.
- Inclusive capture deliberately omits wallpaper, desktop icons, Dock and menu bar and uses a
  solid black background. Approved application windows retain display position/compositing.
  The Tauri controls state this explicitly. No attempt to sample an unfiltered frame as wallpaper.
- Maximum 3840×2160 bounding box, aspect preserved including portrait monitors, 30 fps,
  cursor enabled, no audio. IOSurface-backed samples go to `AVSampleBufferDisplayLayer`, not
  through JSON, JavaScript or JPEG encoding. Native windows are independent of Tauri opacity,
  click-through, capture protection and room restoration.
- Stop or closing the output window invalidates pending callbacks, stops capture and
  clears/closes the output and removes the virtual display. Stream errors, permission revocation, lock/sleep and display topology
  changes also stop/clear it. A static desktop is allowed to keep its last valid frame.
- Capture never starts automatically on launch or after wake/reconfiguration. Permission is
  granted only through macOS. The settings button opens the reusable drag-to-authorize guide and `Privacy_ScreenCapture` together. The guide is also the second first-launch setup step after Input Monitoring.

## Automated verification

```sh
cd frontend
bash scripts/test-screen-share-macos.sh
bash scripts/test-virtual-display-macos.sh
cargo test --locked --manifest-path src-tauri-client/Cargo.toml
bun run client:build
node --test tests/i18n.test.mjs
UI_BROWSER=webkit node --test tests/client-chrome.test.mjs
```

Policy tests cover production/test identity, nested helpers, VooV spellings, unrelated Tencent
apps, exact rather than substring matching and landscape/portrait sizing. Swift is typechecked
for Intel and Apple silicon. UI tests check macOS-only entry, explicit invocation and errors;
they do not verify real capture or third-party compatibility.

## Native acceptance (separate test identity)

Build an app with another `identifier`, `productName`, `mainBinaryName` and empty updater
endpoints. Grant that app Screen Recording; restart it if macOS requests it.

1. Open 共享画面, choose each monitor, start; check readable live output and cursor motion.
2. Cover a normal app with ShareCode, its permission helper, Tencent Meeting and VooV. The
   output should still show the normal app underneath, without excluded windows or recursion.
3. While streaming, start/restart each meeting app; open dialogs, floating toolbars and helper
   windows, move them across monitors. Verify none enter the output.
4. In a third-party conferencing/recording app, select the **secondary monitor display**.
   Verify live remote output, including while the physical screen runs another full-screen app.
   Do not share the physical source display, which has not been filtered.
5. Stop, close output, lock, sleep, revoke permission and disconnect the selected
   monitor. The output must clear; restart explicitly. Also test an idle screen for >10 seconds
   and repeated start/stop while an enumeration/start callback is outstanding.
6. Verify macOS 12.3 and current macOS on both architectures before claiming full compatibility.
   Code availability/type checks alone do not prove old-OS launch or native visual behavior.

## Native startup regression

The first permission-granted startup crashed inside `CGColorGetAlpha` from
`SCStream.serializeStreamProperties`. The SDK declares `SCStreamConfiguration.backgroundColor`
as an **assign** `CGColorRef`; assigning a temporary `NSColor.black.cgColor` did not keep it
alive through stream startup. Leave that optional configuration unset; the opaque output
surface supplies black behind the default capture background. Regression acceptance must
exercise real permission-granted start/stop, not only compilation or mocked UI states.

## Display picker — 2026-10-26

The display picker uses the shared Radix Select components, including the app's theme,
text/background opacity and keyboard interactions. It is disabled while sharing, loading,
unsupported or without available displays. The popup height respects available window space.
The existing share-menu browser cases pass in Chromium, Firefox and WebKit, including display
selection, active-capture lockout, preserved selection, Escape dismissal and both theme surfaces.

The earlier physical output-window design described below is superseded by the virtual-display
implementation above. Historical Chrome/off-screen measurements are retained as evidence for
that earlier design; they do not establish current virtual-display receiver compatibility.

## Real Chrome visibility experiment — 2026-10-26

Tested on macOS 26.6.2 (25G83), Apple silicon, Google Chrome 155.0.8059.85.
The isolated `dev.sharecode.visibility-test` app generated changing synthetic pixel buffers at
10 fps through the same `AVSampleBufferDisplayLayer` output mechanism. Chrome's actual
`getDisplayMedia` window picker selected this window. A loopback-only page measured incoming
video callbacks and pixel hashes; no desktop content or meeting participants were involved.
This tests the downstream native output surface, not the upstream filtered desktop stream.

Each condition lasted 8 seconds, alternating with visible recovery. After excluding transitions:

| Condition | Stable interval | Source buffers enqueued | Chrome video frames | Pixel hash changes |
| --- | ---: | ---: | ---: | ---: |
| Visible baseline | 5.25 s | 53 | 52 | 21 |
| Fully covered by opaque floating test window | 5.00 s | 50 | 50 | 20 |
| Completely outside all displays (x = 1670 pt) | 5.00 s | 50 | 50 | 20 |
| `NSWindow.orderOut(nil)` | 5.00 s | 50 | 0 | 0 |
| `NSApplication.hide(nil)` (app-hide behavior) | 5.25 s | 52 | 0 | 0 |
| `NSWindow.miniaturize(nil)` | 5.50 s | 55 | 0 | 0 |

The hidden/minimized streams stayed `live` and unmuted while their pixels froze; track state
alone is insufficient. Restoring visibility resumed frames without reselecting the source.
Pixel hashes were sampled at 4 Hz, not every incoming frame.

Picker observations in the same Chrome session:

- Already off-screen: **listed and selectable**. Starting a new stream while it remained
  outside all displays produced 463 frames and 187 pixel changes in 46.76 seconds, at
  1280×784 physical pixels (640×392 pt including native frame). No move back on-screen was
  needed to select it.
- `orderOut` and app-hide: **not listed** in the window picker.
- Minimized: **listed**, but selecting it **restored the window** (`miniaturized` became false,
  `visible` became true) and then delivered live content. This does not permit an always-minimized
  output. Minimizing an already-selected window froze it as shown above.

Recommendation: use an open, opaque, full-size output positioned outside all displays, with
an explicit restore/preview control. Do not use `orderOut`, app-hide or minimization to keep
an active shared output out of view. Chrome on this machine supports selecting an already
off-screen source; this is not a guarantee for other browser/macOS versions or Zoom.
Zoom is not installed here. Tencent Meeting's home showed an existing meeting active on
another device; no meeting was joined and its capture behavior was not tested.

Reproduction: `frontend/scripts/screen-share-visibility-test/README.md` and adjacent native
source, local receiver and report script. Raw local measurements are in
`build/share-visibility-test/first-run.jsonl` and `observations.jsonl` (ignored build artifacts).
The prototype had an HTML `stop`/`window.stop` name collision discovered during picker testing;
it was fixed with explicit element references. The initial 88-second sequence and frame/hash
measurements were unaffected. Final stop was verified with an `ended` track and no Chrome
sharing indicator. The test app, browser tab and loopback server were then stopped.

### Off-screen distance stress test — same machine / Chrome

The follow-up experiment moved only the synthetic source along x (y=120 pt, fixed 640×392 pt
window). Requested position, AppKit frame and WindowServer bounds were recorded separately.
Each probe lasted 6 seconds; the first 2 seconds were excluded from frame statistics.

- Ordinary `NSWindow.setFrameOrigin` **constrained requests x=2,000 and x=10,000 to x=1,670**
  initially. The earlier x=1,670 observation was therefore not evidence that arbitrary positions
  are accepted by the default window implementation. Exact clamping is not a portable limit.
- A test-only `NSWindow` subclass overriding public `constrainFrameRect(_:to:)` to return the
  requested rectangle accepted x=2,000, 10,000, 32,767, 65,535, 100,000, 1,000,000, 10,000,000,
  100,000,000 and 1,000,000,000. Chrome received approximately 10 fps with changing pixels at
  every one of those positions. This override was **not added to the production window**.
- Chrome also listed and started a fresh stream for the source already at x=1,000,000,000.
  However, **visual inspection showed displaced/duplicated right-edge content at this extreme
  position**. Moving back to approximately x=1,000,000 restored an intact-looking window.
  Frame/hash changes at extreme coordinates do not prove correct rendering.
- Fine probes still yielded changing pixels at x=1,073,741,952, but x=1,073,742,848 yielded
  constant black video. x=1,100,000,000, 1,500,000,000 and approximately 2,147,480,000 also
  yielded black video while video callbacks continued at approximately 10 fps. This is an
  observed failure region for this configuration, not a documented or universally safe limit.
- Negative probes through an intermediate x=10,000 yielded live content at x=-10,000,
  -1,000,000 and approximately -1,000,000,000; approximately -1,100,000,000 was black.
  Direct multi-billion-point jumps between positive and negative extremes sometimes left
  WindowServer at the old position even though AppKit reported the requested one.
- Extreme movement also introduced rounding/drift (e.g. AppKit x=1,000,000,000 while
  WindowServer reported x=1,000,000,016). Readback was updated continuously; an immediate
  post-move WindowServer read can also be stale.

Practical conclusion: moving thousands or millions of points away is possible with the public
window constraint override; enormous coordinates add precision/capture failures. For the actual
feature use a modest distance relative to the union of displays, verify the resulting frame,
and restore/reposition on display changes. Do not treat one billion points as a production-safe
placement just because pixel changes were observed there.

Reproduction uses `distance.py` alongside the earlier visibility harness (`POSITION_MODE=rawx`,
`CONTINUE_CLAMPED=1`, `REBASE_POSITION=1` as documented). Local raw data and summaries are
`build/share-visibility-test/distance-samples.jsonl` and `distance-results.jsonl`.


## Historical physical output and Retina capture — 2026-10-26 (superseded)

The production output is titled exactly `secondary monitor` in either language. It fills the
selected display's complete frame, with content extending under the transparent native title
bar, and no half-resolution initial window size. It remains a normal window in the current
Space: moving into a native macOS full-screen Space could change which source applications
are visible. The close/zoom controls remain available, and users can switch to other apps.
Starting again fills the selected display again. This implements the chosen simple visible
output-window design; it does not enable the earlier experimental off-screen positioning.

Capture uses the selected display mode's backing pixel dimensions, capped at 3840×2160 at
30 fps with aspect preserved and no upscaling. The video layer preserves aspect if the output
is resized. This raises the source detail ceiling; receiving software may still downscale or
compress its stream. 4K needs more GPU/memory/bandwidth than the earlier 1080p limit; sustained
4K capture performance and remote conferencing quality still need integration verification.

Exclusions remain application-wide: the actual current process/bundle, ShareCode bundle family
and nested helpers, plus Tencent Meeting/WeMeet/VooV and known nested helper bundles. The
output is intentionally shareable by other applications while excluded from our own input.
The including-applications allow-list is refreshed once per second; newly discovered processes
are not included before classification. No window-title matching is used.

Verified the actual `SharedOutputWindow` implementation in isolated
`dev.sharecode.output-layout-test`: title `secondary monitor`, window and content both
1710×1112 pt matching the screen exactly, 2× backing scale, no native full-screen Space.
Inspected all four content edges and text. Local report: `build/output-layout-test/result.json`.
This native layout check uses a synthetic pattern and does not claim live filtered desktop
capture or Chrome/Zoom quality validation for this revision.

Passed native policy/placement tests and Apple silicon/Intel Swift availability typechecks,
10 Rust tests, client production build, 4 i18n tests and 3 focused Chromium share-popover tests.
