# Adaptive screenshot capture — 2026-10-26

Historical first optimization: the CPU-only comparator described here was subsequently replaced by full Metal comparison with CPU fallback. See `client-capture-gpu-macos.md` for current implementation and measurements.

Implemented in `frontend/src-tauri-client/native/ScreenshotCapture.swift`. Start and visible changes use a 30 fps timer. After 250 ms without a pixel change use 15 fps; after one second use 5 fps. On detecting a change restore 30 fps. Idle detection is polling: 200 ms target plus capture/comparison/scheduling latency, not an input-event guarantee. Continuous video/scrolling stays at 30 fps; a blinking caret may prevent reaching 5 fps. Mouse remains included in the captured pixels (`showsCursor = true`). No new input hooks/permissions.

An exact row-wise libc `memcmp` of BGRA bytes executes on a serial background queue; padding is ignored. It detects even one-byte changes at the last pixel, with no lossy thumbnail or hash. A retained previous pixel buffer costs up to about 32 MiB at 4K. Different dimensions/formats or lock failures conservatively count as changed. One request/comparison maximum, including across stop/restart. Allow-list replacement resets cadence/history and rejects stale screenshot/comparison results. Idle frames continue to reach the existing liveness watchdog. App exclusion refresh, permission checks, screen sizing, capture resolution and 12.3–13 SCStream behavior remain intact.

## Local A/B comparison

Same M2 Air, battery power and low-power mode. Eight 13-second phases, discard first 3 seconds, reverse order across conditions. Same executable: `snapshot-fixed` disables adaptive comparison; `snapshot` uses production default. Whole app includes fixture animation and counter decoding; replayd is system capture work. CPU 100% means one core, not the whole 8-core computer. Source synthetic 1080p, 4K capture is upscaled; output display negotiated 2560×1440. No meeting encoder/network. Single short pass, not battery or long-term stability measurement.

| Capture | Motion | Fixed app + replayd CPU | Adaptive app + replayd CPU | Reduction | Fixed / adaptive fps |
|---|---|---:|---:|---:|---:|
| 1920 | static | 22.96% | 9.32% | 59.4% | 29.20 / 5.00 |
| 1920 | dynamic | 24.65% | 24.64% | 0.0% | 29.30 / 29.20 |
| 3840 | static | 22.95% | 11.33% | 50.6% | 29.30 / 5.00 |
| 3840 | dynamic | 24.64% | 24.63% | 0.0% | 29.20 / 29.11 |

WindowServer also fell during static phases (1080p 50.51→38.73%, 4K 56.12→38.44%), but it includes the rest of the desktop so those differences are not solely attributable to our app. Dynamic CPU remained essentially unchanged. App static RSS rose roughly 9 MiB at 1080p and 32 MiB at 4K. No reported capture errors, invalid frames, or elevated thermal state. Battery telemetry is too slow for phase-by-phase energy attribution.

## Verification

- `bash frontend/scripts/test-screen-share-macos.sh`: policy/placement/sizing/lifecycle tests passed; exact final-pixel change, dimension change, cadence backoff/reset/resume tests passed; arm64 and x86_64 native typechecks passed.
- Live same-session transition test (no capture restart): settled at 5 fps, changed only the final source pixel and observed ~33 ms frame gaps again, settled back to 5 fps, then enabled animation and recovered >28 fps. No capture errors/invalid buffers. This verifies pixel-triggered cadence recovery, not physical mouse motion or conferencing latency.
- Tests retain separate bundle ID `dev.sharecode.capture-filter-test`; quit, removed both virtual displays (online display list `[1]`), reset only that recording grant and moved its app to Trash. System Settings confirmed the test row disappeared; production permissions untouched.

Reproduction: build fixture via `python3 scripts/macos-signing.py run -- bash frontend/scripts/capture-benchmark/build.sh`, launch with the isolated recording grant, run `python3 frontend/scripts/capture-benchmark/run.py --adaptive`. Relaunch and run `verify-adaptive.py` for same-session transitions. Results in `notes/client-capture-adaptive-macos-results.json`; raw 1-second samples in ignored `build/capture-benchmark/adaptive/metrics.jsonl`.

## CPU instruction sets and Metal experiment

M-series Macs execute ARM64, not x86 AVX/SSE. Production calls the platform libc memcmp instead of a Swift byte loop; no hardware-specific instruction requirement was added. The relevant ARM SIMD family is NEON. Handwritten intrinsics would need separate ARM/Intel implementations and have not been shown to outperform libc here.

A separate permission-free synthetic IOSurface/CVPixelBuffer experiment compares the same exact BGRA rows using production memcmp versus a Metal texture kernel. Metal writes one shared boolean flag; command submission, flag reset and wait are included; pipeline creation/texture creation are outside the timed loop. 100 iterations after five warmups, same M2, after the client build exited. CPU time uses getrusage; wall time includes GPU completion. This is a microbenchmark, not an integrated capture/power test.

| 4K scenario | memcmp CPU ms/call | Metal CPU ms/call | memcmp wall ms/call | Metal wall ms/call |
|---|---:|---:|---:|---:|
| identical | 1.659 | 0.100 | 1.660 | 1.553 |
| first-pixel | 0.004 | 0.117 | 0.004 | 1.928 |
| last-pixel | 2.619 | 0.127 | 2.654 | 1.535 |

Metal can reduce CPU spent comparing an unchanged 4K image, but it transfers work to the GPU. At the new 5 fps idle rate the measured comparison difference is roughly 0.8 percentage points of one CPU core, not a 16× reduction of the capture pipeline. On an early differing pixel, memcmp short-circuits in ~0.004 ms while this GPU kernel still scans the whole frame and costs ~1.9 ms wall time. GPU power/total energy was not measured. Production therefore retains the simpler exact libc comparison; Metal remains an experiment, not part of the built client. A hybrid would require integrated profiling and device/failure fallbacks before shipping.

Reproduce: compile ScreenshotCapture.swift with frontend/scripts/capture-benchmark/compare-pixels.swift using swiftc -O, then run the binary. Evidence: notes/client-capture-pixel-comparison-macos-results.json.

## Installer

Universal local installer: `build/macos-dist/0.2.2-universal-manual.mPALit/ShareCode Client_0.2.2_universal.dmg`. Native tests/typechecks, client Cargo tests (10 passed), TypeScript/client production bundle, universal app build, fixed-certificate verification and DMG integrity/layout verification passed. No install, release or server change.
