# macOS meeting application identity audit

## Packages inspected

Six DMGs downloaded from Tencent's CDN, each matching the SHA-256 in its pinned
Homebrew cask. No installer or extracted executable was run. The main executable's
Mach-O header confirmed the architecture below. Apple code signatures were not
verified on this Windows workstation.

| Product | Version | Main architecture | App/XPC bundles |
| --- | --- | --- | --- |
| Tencent Meeting | 2.16.2.420 | x86_64 | 4 |
| Tencent Meeting | 3.47.2.407 | arm64 | 8 |
| Tencent Meeting | 3.47.2.407 | x86_64 | 8 |
| VooV Meeting | 3.7.0.590 | x86_64 | 6 |
| VooV Meeting | 3.43.0.510 | arm64 | 8 |
| VooV Meeting | 3.43.0.510 | x86_64 | 8 |

The [machine-readable inventory](client-meeting-privacy-macos-versions.json)
contains publisher download URLs, pinned cask sources, hashes, sizes, main
architectures and every extracted app/XPC plist identity and location. Cached
DMGs and extracted plists stay in ignored `build/meeting-macos-audit/`.
An attempted older VooV 1.7.1.510 download returned HTTP 404; it is not counted.
These are representative packages, not every release or Mac App Store builds.

## Findings and change

The main bundle IDs remain `com.tencent.meeting` (Tencent) and
`com.tencent.tencentmeeting` (VooV). The latter's CFBundleName is also 腾讯会议,
so the displayed product name alone does not distinguish the two.
Launchers, `wmexternal`, `Transcode`, `TranscodeBridge`, `FileDelta` and
`UpdateServer` use the existing meeting ID namespaces. The original policy
already excludes all inspected bundles at their original package paths.

Two helper identities rely on containment rather than those namespaces:
`com.tencent.UpdateService` in Tencent 2.16 and `com.tencent.VooVUpdateService`
in both VooV versions. The former policy used only the enclosing app's filename
for these. Renaming the outer application could therefore leave these helpers
unrecognized. This is a detection gap, not evidence that an updater actually
appeared in a captured frame.

`CapturePolicy` now checks bundle IDs of enclosing `.app` packages as well as
the existing names. `ScreenShare.allowed` checks both NSRunningApplication's
bundle URL and executable URL, rather than discarding the executable URL when
a bundle URL exists. This covers a nested executable whose bundle metadata is
incomplete and preserves the existing own-app exclusion.

The new lookup stays inside the executable/bundle's enclosing applications;
it does not match window titles, Qt classes, generic process names or every
`com.tencent.*` identifier. Standalone `UpdateService` / `VooVUpdateService`
identities remain allowed without a recognized meeting container. Bundle ID
matching is capture policy, not publisher authentication.

## Validation and reproduction

The static audit completed for all six DMGs and 42 app/XPC bundles:

```sh
python frontend/scripts/audit-meeting-macos.py \
  --inventory notes/client-meeting-privacy-macos-versions.json \
  --cache build/meeting-macos-audit --seven-zip /path/to/7z \
  --output build/meeting-macos-audit/audit.json
```

`native/tests/main.swift` includes sampled helper IDs, the two exceptional
updaters under renamed meeting containers, and an unrelated container with a
similar ID. Run the existing `frontend/scripts/test-screen-share-macos.sh` on a
Mac to compile and exercise these cases. This Windows session did not run the
macOS native tests, ScreenCaptureKit or a live meeting. Static plist presence
does not establish which processes own windows at runtime. The existing
one-second allow-list refresh and screenshot/SCStream lifecycle are unchanged.
