# macOS capture comparison — 2026-10-26

Local isolated test, no production server. M2 MacBook Air (Mac14,2), 16GB, macOS 26.6.2, battery power, Low Power Mode enabled and unchanged. User capped total work at approximately ten minutes including build/setup. Actual automatic capture comparison took approximately two minutes: nine 13-second phases, discard first three seconds of each. This is a short comparison, not a ten-minute soak or battery rundown.

Uses production ScreenshotCapture and virtual display/output window implementations, same application-inclusive filter, BGRA, cursor enabled, queue depth 3, 30fps target, and AVSampleBufferDisplayLayer for both methods. No meeting encoder/network workload. Synthetic source is 1920×1080; output virtual display negotiated 2560×1440. “4K” below is requested capture-buffer resolution, upscaled from the 1080p source, not a native-4K desktop test.

CPU is cumulative process CPU time sampled with ps, 100% = one logical CPU core. App includes synthetic source animation, decoding the frame counter, and output rendering; replayd is system capture work. WindowServer is whole desktop work with substantial unrelated baseline and should not be fully attributed to capture. One short pass per condition, no confidence intervals.

| Phase | App CPU % | replayd CPU % | WindowServer CPU % | Complete frames/s | Generation→callback p50/p95 ms | App RSS MiB |
|---|---:|---:|---:|---:|---:|---:|
| idle:static:1920 | 1.37 | 0.0 | 46.68 | 0.00 | None / None | 43.61 |
| stream:static:1920 | 2.35 | 1.08 | 45.19 | 0.00 | None / None | 48.59 |
| snapshot:static:1920 | 4.84 | 17.72 | 50.46 | 29.20 | None / None | 48.87 |
| snapshot:dynamic:1920 | 6.77 | 17.29 | 52.23 | 30.00 | 19.73 / 22.6 | 48.12 |
| stream:dynamic:1920 | 11.78 | 1.28 | 43.82 | 29.30 | 23.56 / 39.58 | 48.4 |
| snapshot:static:3840 | 5.04 | 17.3 | 52.92 | 30.00 | None / None | 48.45 |
| stream:static:3840 | 2.1 | 0.36 | 41.08 | 0.00 | None / None | 48.55 |
| stream:dynamic:3840 | 11.77 | 1.09 | 47.08 | 28.76 | 29.04 / 45.35 | 48.58 |
| snapshot:dynamic:3840 | 7.23 | 18.75 | 60.73 | 30.00 | 21.54 / 22.62 | 48.5 |

## Findings and limits

- Static SCStream produces no new complete frames after settling, retaining its last image; zero fps is expected and is not a freeze. Screenshot capture continues at about 30 fps, including duplicates. Its replayd CPU cost is roughly 17–19% of one core versus 0–1.3% for SCStream.
- Both dynamic methods are near 30 fps in this short synthetic comparison. Latency comes from a timestamped binary counter drawn in the source, measured at capture callback; it excludes output presentation, video encoding, network and remote display. Source/render timing and one short trial prevent general latency superiority claims.
- No reported capture/render errors or invalid frames; render backpressure counts (captured minus enqueued) are listed below. Thermal state stayed nominal (0). Eight capture starts with seven method/resolution transitions completed, followed by stop. Short steady-state RSS changes were below 0.2 MiB per phase. This cannot establish leak freedom or long-term stability; sleep/wake, permission revocation and external monitor changes were not exercised here.
- Whole-machine battery telemetry ranged approximately 6.3–8.4 W, but updated only a few times across the experiment, often spanning multiple phases. Per-phase means in raw data are stale telemetry, not causal energy measurements. No defensible battery-life percentage/hours can be calculated. CPU cost supports a higher ongoing CPU burden for screenshot polling, especially while static; it does not measure total energy by itself.
- For eliminating per-window purple indicators the screenshot path works, but it is not free. Retain the existing bounded one-in-flight capture; consider a lower/adaptive refresh rate for static code editing if reducing power becomes a priority. No production behavior was changed by this comparison.

Reproduce using `frontend/scripts/capture-benchmark/build.sh` (via the existing signing wrapper) and `run.py`, with permission only for the isolated test identity. Raw samples: `build/capture-benchmark/metrics.jsonl`; aggregate evidence: `notes/client-capture-performance-macos-results.json`. Fixture includes CPU-side pixel-buffer inspection for latency, shared across both methods; this adds measurement overhead.

## Output backpressure

- idle:static:1920: 0 captured, 0 enqueued (0 skipped).
- stream:static:1920: 52 captured, 48 enqueued (4 skipped).
- snapshot:static:1920: 397 captured, 397 enqueued (0 skipped).
- snapshot:dynamic:1920: 396 captured, 396 enqueued (0 skipped).
- stream:dynamic:1920: 374 captured, 374 enqueued (0 skipped).
- snapshot:static:3840: 367 captured, 367 enqueued (0 skipped).
- stream:static:3840: 1 captured, 1 enqueued (0 skipped).
- stream:dynamic:3840: 351 captured, 351 enqueued (0 skipped).
- snapshot:dynamic:3840: 390 captured, 390 enqueued (0 skipped).
