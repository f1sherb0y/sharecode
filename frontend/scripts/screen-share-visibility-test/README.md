# Native output visibility experiment

Build with `bash frontend/scripts/screen-share-visibility-test/build.sh` from the repository
root, then launch the printed app path. This is a separate, ad-hoc signed identity
(`dev.sharecode.visibility-test`), never the installed customer client. It generates synthetic
changing pixels at 10 fps through `AVSampleBufferDisplayLayer`, matching the output renderer;
it never requests recording permission or captures the desktop.

Run `python3 frontend/scripts/screen-share-visibility-test/server.py`, open
`http://127.0.0.1:18765` in the browser under test, and select **ShareCode Visibility Test**
under **Window**. Do not select the whole desktop. Start the sequence with the page button.
Each condition lasts 8 seconds with visible recovery intervals between conditions. The source
timer remains active even when hidden, so input starvation can be separated from capture
freezing. Only the test app changes its own windows; other applications are not manipulated.

The local page samples incoming video pixels every 250 ms and records hashes, video-frame
callbacks, track state and source state in `/tmp/sharecode-visibility-test/samples.jsonl`.
No captured image or statistic is uploaded. Run `python3
frontend/scripts/screen-share-visibility-test/report.py` to summarize stable intervals after
excluding transitions. Pixel changes matter: a live track or repeated video frames alone do
not demonstrate live content.

For picker tests, stop the previous stream, write one of `visible`, `covered`, `offscreen`,
`orderOut`, `appHide`, or `minimized` into `/tmp/sharecode-visibility-test/command`, then open
the browser's picker. Inspect whether the source is listed and whether selecting it starts
live frames. `visible` restores the source; `quit` terminates it. Stop the local server and close
the test tab after testing. Logs are local experiment artifacts, not repository fixtures.

This verifies real browser capture of the native output surface. It does not verify the
upstream filtered desktop stream, conferencing network delivery, Zoom compatibility, or
different macOS/browser versions.

## Distance experiment

After selecting the window, run `python3 frontend/scripts/screen-share-visibility-test/distance.py`.
It tests progressively larger x coordinates (points), six seconds per position, excludes the
first two seconds, and reports native `NSWindow.frame`, WindowServer bounds, received frames
and pixel changes. Default mode retains AppKit's `constrainFrameRect` behavior; `POSITION_MODE=rawx`
uses a test-only subclass returning the requested frame unchanged. Pass individual coordinates
as arguments to probe specific boundaries; negative coordinates are accepted. `CONTINUE_CLAMPED=1`
continues after position mismatch; otherwise a mismatch ends the sweep. The source reports
WindowServer bounds continuously because querying immediately after a move can return the
previous position. Results append to `/tmp/sharecode-visibility-test/distance-results.jsonl`.
The sweep returns to an ordinary, AppKit-constrained off-screen position when done.
`REBASE_POSITION=1` moves through x=10,000 between probes, avoiding a single multi-billion-point
delta when switching signs. Native/AppKit coordinates can lose precision at extreme values;
fresh WindowServer bounds and visual inspection are required in addition to frame statistics.
