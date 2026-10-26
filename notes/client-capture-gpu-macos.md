# GPU-assisted screenshot comparison — 2026-10-27

Production implementation is in `frontend/src-tauri-client/native/ScreenshotCapture.swift`. The existing 30/15/5 fps cadence and capture resolution remain unchanged. Every comparison, including continuous animation, uses Metal when available. There is no CPU pixel probe/early-out. Metal compares every BGRA channel of every pixel unless another thread has already proven a difference; incomplete 16-pixel tails are covered. No lossy thumbnail, approximate threshold, or hash. The first frame is delivered without comparison because there is no previous image.

Metal uses IOSurface-backed CVMetalTextureCache textures and a four-byte shared change flag. Each thread examines up to 16 pixels, stopping at the first difference in its chunk, with at most one atomic store per changed chunk. One thread per threadgroup reads the shared atomic flag, then a threadgroup barrier distributes the result. The group returns immediately if any earlier thread has already established a difference, avoiding redundant image reads and flag writes on broadly changing frames without one global atomic read per pixel chunk. Completion is asynchronous, with no main-thread wait or full-image CPU readback. Pixel buffers and texture wrappers stay retained until GPU completion. Pipeline/cache/queue are reused. Unified-memory Metal devices are eligible (the intended M1+ hardware); device/pipeline/cache initialization failure, unsupported texture mapping, or a failed command falls back to exact row-wise CPU comparison. A failed GPU is disabled for that capture driver so failures do not retry every frame.

The existing one-outstanding-work slot now includes GPU comparison. Filter revisions and stop/restart invalidate late GPU completions before presentation; a new session cannot overlap a still-pending old GPU operation. Existing capture watchdog bounds a stalled pipeline. No new privacy permission or input hook. Screenshot capture still includes the mouse and retains the application allow-list; old macOS SCStream path is unaffected. Metal is explicitly linked by the Rust native build.

## Verification

Native tests include real Metal execution on M2: exact equality and one-byte changes in every BGRA channel at first/middle/final pixels, 1×1, odd dimensions, 1080p and 4K, incomplete thread tails, explicit CPU fallback, and a localized edit outside the edge/center rows. Controlled asynchronous completions verify no overlapping work, stale filter results, stop/restart and stale session results. Policy/sizing/lifecycle suite and both arm64/x86_64 typechecks passed (`build/capture-gpu-native-tests.log`). These do not claim live testing on other Macs/OS versions.

## Measurement method

Isolated signed test app `dev.sharecode.capture-filter-test`, local-only, no production server. Compare CPU-only adaptive (`snapshot-cpu`) and full GPU adaptive (`snapshot`) in the same executable, ten 13-second phases, discard first three seconds. Counters record actual Metal and CPU comparisons to detect hidden fallback. M2 Air 16GB, macOS 26.6.2; synthetic source 1920×1080, output negotiated 2560×1440, 4K means requested capture buffer resolution upscaled from source. No meeting encoder/network workload. 100% CPU = one core. App includes fixture animation and source counter decoding; replayd is capture service. Single short trial per condition, not a battery or long-duration stability test.

Numeric backend counters are part of the fixture output: GPU phases must report Metal comparisons and zero CPU comparisons, including dynamic phases. CPU comparison remains a fallback for unsupported/failed GPU operation, not the normal dynamic path.

The capture timer is now a one-shot deadline based on the previous request start. A completion narrowly missing its target can resume immediately instead of waiting for another repeating-timer tick; operations remain serialized and capped at 30 fps. Both CPU and GPU A/B modes use this scheduler.

A same-session native transition run verifies 4K capture: idle ~5 fps, a single final-source-pixel change restores fast intervals, idle settles back to 5 fps, then animation runs ~30 fps. Metal counters increase throughout and CPU fallback count stays zero. The transition collector observes more than two one-second status windows to avoid missing the post-command interval. Intervals later in the single-pixel observation return to 15/5 fps as expected because that one edit becomes static again.

## Final A/B results (deadline scheduler + full GPU)

| Capture | Scene | App CPU: CPU / GPU | App + replayd CPU: CPU / GPU | FPS: CPU / GPU |
|---|---|---:|---:|---:|
| 1920 | static | 3.65% / 3.02% | 9.13% / 8.42% | 5.00 / 4.90 |
| 1920 | dynamic | 6.31% / 7.22% | 23.42% / 24.59% | 28.50 / 28.50 |
| 3840 | static | 5.76% / 3.38% | 11.25% / 8.86% | 5.00 / 5.00 |
| 3840 | dynamic | 9.29% / 10.64% | 30.78% / 30.51% | 25.40 / 25.70 |
| 3840 | blink | 15.05% / 6.37% | 29.47% / 21.30% | 21.40 / 21.10 |

The blink workload changes one source pixel every half second, exercising sparse changes without permitting 5 fps idle throughout. The exact comparison detects these changes. App CPU fell ~41% in 4K static and ~58% in sparse blinking; including replayd the reductions were ~21% and ~28%. Full animation does not show a general CPU benefit: GPU submission adds app CPU, and total app+replayd was essentially unchanged at 4K and slightly higher at 1080p. This is a deliberate full-GPU policy per user preference, with CPU fallback for failures only.

The active desktop affected WindowServer and capture timing; 4K full animation ran ~25 fps in both final A/B phases, while the separate transition test approached 30 fps. Do not promise a stable 30 fps under every desktop load or infer a universal speedup. No reported capture errors or invalid frames, thermal state nominal. Real GPU counters were positive in every GPU phase, CPU fallback counters zero, including full animation and blinking. Battery telemetry was recorded but no total-energy/battery-life improvement is claimed. Full-frame buffer comparison remains exact; small localized changes are covered by both synthetic Metal unit tests and permissioned capture tests.

Raw samples: `build/capture-benchmark/gpu/metrics.jsonl`; shareable numeric aggregate: `notes/client-capture-gpu-macos-results.json`. Reproduce with the isolated fixture and `python3 frontend/scripts/capture-benchmark/run.py --gpu`; transition verification: `verify-adaptive.py --output build/capture-benchmark/gpu`.

## Cleanup and final checks

The test app exited; online displays returned to `[1]`. Only `dev.sharecode.capture-filter-test` recording permission was reset, its bundle moved to Trash, and System Settings confirmed its row disappeared. The production client recording grant remained on. Final native suite also verifies that a delayed GPU completion automatically resumes deadline scheduling without overlapping work.

The UI tool's repeated `getApp` timeout was an accessibility/window-state observation timeout; successful launch was separately verified through fresh PID/status samples. No capture timeout or crash was inferred from that UI-tool error.

## Verified installer

`build/macos-dist/0.2.2-universal-manual.MihtR2/ShareCode Client_0.2.2_universal.dmg` contains the final all-GPU implementation and deadline scheduler. Final native exactness/lifecycle/scheduler tests and arm64/x86_64 typechecks passed; 10 client Rust tests, TypeScript/client production build, both release architectures, fixed certificate/designated requirement verification, DMG checksum and Finder layout checks passed. Logs: `build/capture-gpu-native-tests.log`, `build/capture-gpu-client-build.log`. No production installation, publishing or server modification.
