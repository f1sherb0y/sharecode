# Native title-bar sharing indicator experiment

Build with `python3 scripts/macos-signing.py run -- bash frontend/scripts/capture-indicator-test/build.sh`.
This uses the fixed local certificate so rebuilding the isolated fixture retains its temporary
permission. It does not use the production bundle ID or connect to any server.

Launch `build/capture-indicator-test/ShareCode Filter Source.app` and
`ShareCode Capture Filter Test.app`. Grant Screen Recording only to the latter with the
user's authorization. The source has no capture code. The capturing app starts stopped.
Write a mode to `/tmp/sharecode-capture-indicator-test/command`:

- `apps`: original application allow-list stream (synthetic source only).
- `windows`: window allow-list stream.
- `apps-menu`: application allow-list stream with menu bar enabled.
- `exclude`: display exclusion stream (all currently discovered apps except the source excluded).
- `snapshot` / `snapshot-4k`: application allow-list screenshots at 2560×1662 / 3840×2160,
  bounded to one outstanding request, at most 30 requests/sec.
- `production`: the actual production controller, with the virtual display and real exclusions.
  The fixture samples that output display once/sec into a local preview, never disk or network.
- `stop` / `quit`: stop capture and release output / also terminate the test app.

`status.json` contains frame counts, sampled green source pixels and magenta excluded pixels,
distinct output hashes, filter style and numeric diagnostics, not screen images. It contains
no ordinary window titles or document text. `CAPTURE_PROBE` compiles numeric incoming-frame
diagnostics into the fixture only. Release builds do not contain them.

`excluded/main.swift` is a synthetic magenta window with a separate nested test bundle identity
`com.tencent.meeting.sharecode-capture-test`; it neither runs nor replaces Tencent Meeting.
Starting it during production capture verifies new excluded processes are never admitted.
The real Tencent Meeting app can also be positioned on the source display and compared with
the output preview. Do not join a meeting or transmit anything for this test.

Afterwards stop all fixtures, reset ScreenCapture for `dev.sharecode.capture-filter-test`,
check System Settings, and move the disposable test app bundles to Trash. Keep source and
numeric result artifacts for reproducibility.

For permission-free screenshot lifecycle checks run `frontend/scripts/test-screen-share-macos.sh`.
