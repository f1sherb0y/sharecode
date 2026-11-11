# Shared display: less work per frame — 2026-11-11

Follows `client-capture-gpu-macos.md`. The capture rate (30/15/5 fps), the
resolution, the exact comparison and the allow-list are unchanged. Four things
the shared display did without need are gone. Code:
`frontend/src-tauri-client/native/ScreenshotCapture.swift` and `ScreenShare.swift`,
which both the Tauri client and the MyGo host build.

| Change | Before | After |
|---|---|---|
| An unchanged frame | enqueued on the output layer again, 5 times a second on a still screen | not shown again (the output already shows it); it still feeds the watchdog, and the output is refreshed every 2 s |
| Steady motion | every frame compared with the one before, to learn it differs | after 8 changed frames in a row, one in four is compared; the end of the motion is noticed at most 100 ms later |
| The allow-list | every application and window listed through ScreenCaptureKit each second | listed when the set of processes owning windows changes (`CGWindowListCopyWindowInfo`, each second) and every 5 s regardless |
| Metal comparison | pipeline, queue and texture cache kept for the life of the process; texture wrappers left in the cache | released when sharing stops; the cache is flushed after each comparison |

The allow-list stays fail-closed: a process that is not on the list is never
captured, so a late refresh can only show a new application late (at most 5 s,
normally within the second its first window appears). The source display's mode
and bounds are still checked every second.

## Measured

M2 Air, macOS 26.6.2, the desktop in use. `frontend/scripts/capture-benchmark`
fixture run from a shell (it has that shell's Screen Recording), 4K capture,
13-second phases with the first 3 discarded. `snapshot-old` is the earlier
behaviour in the same executable (`economy: false`). A second stream captures
the output display at 720p, as a meeting app would, and counts the frames
WindowServer reports as new. 100% CPU is one core.

| Scene | App CPU old / new | replayd old / new | New frames on the output per second, old / new |
|---|---:|---:|---:|
| static (2 runs each) | 1.52% / 1.44% | 3.13% / 3.14% | 9.4 / 5.9 |
| dynamic (3 runs each) | 5.23% / 4.60% | 10.79% / 10.96% | 28.2 / 28.2 |

- Dynamic: the app's CPU is 12% lower in each of the three pairs; capture itself
  (replayd) and the delivered frame rate are the same.
- Static: the app's own saving is within the noise. What changes is the output:
  about 3.5 fewer new frames a second reach whoever captures the virtual display
  (the rest, about 5.5 a second, are not ours: the fixture enqueues 0.5). What
  that saves in a meeting app's encoder was not measured.
- The allow-list, measured apart (38 applications, 171 windows, 20 calls): one
  ScreenCaptureKit listing costs 14 ms of CPU in the client, 20 ms in
  WindowServer and 3 ms in replayd, 37 ms in all, every second. The window-owner
  check costs 1.4 ms in the client and 3.6 ms in WindowServer. With a listing
  every 5 s that is about 12 ms a second instead of 37: roughly 2.5% of a core
  less while sharing, moving or not. For scale, the app and replayd together
  use 4.6% on a still 4K screen. This saving is in the controller, which the fixture does not run:
  it is computed from the two measurements, not observed end to end.
- GPU utilisation from `ioreg` was recorded but moves with the rest of the
  desktop (55–69% in every phase); nothing is claimed from it.

Tried and removed: slowing to 10 fps after an isolated change while nobody
types (a blinking caret). At 4K it captured as many frames as before and saved
nothing measurable.

Not done: a real meeting app on the output, battery or energy, other Macs, and
the macOS 12.3–13 stream path (unchanged apart from the allow-list refresh).

Reproduce: build the fixture as in `frontend/scripts/capture-benchmark/build.sh`,
start it, then `python3 frontend/scripts/capture-benchmark/run.py --economy`.
Tests: `bash frontend/scripts/test-screen-share-macos.sh`.
