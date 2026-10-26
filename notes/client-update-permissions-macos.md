# macOS client update permissions — local experiment

Date: 2026-10-26. Host: macOS 26.6.2 (25G83), Apple silicon.

## Scope

Use the real customer client's Rust/Swift backend and `tauri-plugin-updater`
2.10.1, with a small local-only frontend in
`frontend/scripts/update-permission-test/`. No production endpoint, production
updater key, installed production app, or production permission is changed.

Test identity: `dev.sharecode.client.update-permission-test`, product
`ShareCode Update Permission Test`, executable `sharecode-update-permission-test`.
Version A is 0.2.2; B is 0.2.3. Both are debug app bundles built with config
overrides. The installed path stays identical during the update. Each B archive
is signed with a disposable minisign key, independently of its macOS code
signature. The local server listens only on `127.0.0.1:18766`.

The production build script explicitly sets `APPLE_SIGNING_IDENTITY=-` and
`bundle.macOS.signingIdentity="-"`. The installed production app's designated
requirement also consists of architecture-specific code hashes. This is ad-hoc
signing; a signed Tauri update archive does not change that fact.

## Completed checks

Both A and B pass `codesign --verify --deep --strict` in both modes. Extract A's
designated requirement with `codesign -d -r-`, then evaluate it against B with
`codesign --verify -R '=REQUIREMENT' B.app`:

| Code signature | B satisfies A's designated requirement |
| --- | --- |
| Current ad-hoc method | No: code hash changes |
| Same self-signed certificate for A and B | Yes: bundle identifier and certificate hash stay the same |

The disposable certificate was imported into a separate temporary keychain.
No trust setting was changed; the original keychain search list was restored
after signing. These identity checks do **not** by themselves constitute a TCC
permission-retention test.

The local endpoint returns a signed 0.2.3 update for 0.2.2 and HTTP 204 for
0.2.3. The fixture frontend contains neither production domain. The running
test A reports `permissionRequired` for the native input listener and `false`
for `CGPreflightScreenCaptureAccess()` before any grant.

## Native permission experiment — completed

The user explicitly authorized temporary Input Monitoring and Screen Recording
for this isolated test app, followed by revocation and cleanup.

| Signing mode | Authorized A | Same-version A restart | Actual updater A → B |
| --- | --- | --- | --- |
| Ad-hoc (current production build method) | Both granted | Both retained | **Both lost** |
| Same self-signed certificate | Both granted | Both retained | **Both retained** |

Observed through the actual native code, not just Settings switches:

- Ad-hoc A restart (PID 32243): native input permission `true`, listener
  `listening`, recording permission `true`. After the signed local archive was
  installed by Tauri and relaunched as B (PID 32267), native input permission
  became `false`, listener phase `permissionRequired`, recording permission
  `false`. The normal permission guide reopened. System Settings still showed
  Input Monitoring ON, demonstrating why the switch alone is insufficient.
- After resetting only the test identity, self-signed A was granted both
  permissions. A restart (PID 32332) retained both. Actual updater/relaunch to B
  (PID 32354) retained native input permission `true`, listener `listening`, and
  recording permission `true`; the main window opened without reauthorization.
- The temporary signing keychain was deleted **before** launching self-signed
  A. No root certificate was trusted and no trust settings were modified. The
  self-signed result does not rely on the signing identity being installed on
  the user's machine.

Raw selected samples, native startup events and signing identity checks are in
[`client-update-permissions-macos-results.json`](client-update-permissions-macos-results.json).
Both updates ran through `check()` → `downloadAndInstall()` → `relaunch()`, with
only the local endpoint and disposable update-signing key. No capture stream
was started: this experiment checks permission continuity, not captured pixels.
The input worker is the actual listen-only event tap and logs no ordinary keys.

### Conclusion and scope

For our existing ad-hoc build method, the tested update required reauthorization
of **both** permissions. Replacing it with a stable self-signed code-signing
identity preserved both across the tested update, without a paid Developer ID.
This is a concrete result on this macOS/arm64 host with the actual client native
backend and updater, using an isolated identifier and debug fixture frontend;
it is not a cross-version macOS or universal release-build certification.

Adopting this for releases requires keeping the same certificate/private key,
bundle identifier and compatible designated requirement for subsequent builds.
The first migration from the existing ad-hoc identity is an identity change;
do not promise that existing users' grants carry over during that migration.
Self-signing does not provide Apple notarization or trusted Developer ID status,
and does not remove first-install Gatekeeper warnings. The subsequent fix changes production packaging to a pinned, persistent self-signed
certificate via `scripts/macos-signing.py`; no release is published as part of the fix.
The experiment above used a disposable certificate, not the new persistent key.

### Cleanup — completed

- Quit the test app and stopped the local server.
- `tccutil reset All dev.sharecode.client.update-permission-test` succeeded.
- Verified in System Settings: no test app in Input Monitoring or Screen
  Recording; production ShareCode Client remained ON in both.
- Temporary keychain removed; original keychain search list restored; disposable
  private keys/passwords/key-generation log deleted.
- Test bundles, binary, WebKit data and diagnostics moved to a recoverable Trash
  archive; its manifest and path are recorded in the results JSON.
- Production servers, installed production app, its permissions and production
  update-signing key were not modified.

## Persistent-certificate build fix — 2026-10-26

A new, persistent certificate (separate from the disposable experiment key) now
signs customer macOS builds. The encrypted P12/password are stored outside Git
in `~/.tauri/sharecode-macos/`; the public fingerprints are pinned in
`docs/macos/signing-identity.json`. Both Tauri configuration and the local/CI
build script select this identity. The existing updater minisign key is unchanged.

Validation completed:

- Full universal release build: 10 Rust tests and TypeScript/Vite client build passed.
- Both arm64 and x86_64 certificate fingerprints and exact designated requirements
  verified in the app and again in the mounted final DMG; DMG checksum/layout checks passed.
- Native isolated fixture regression checks passed: ad-hoc rejection, compatible
  A/B identity with the persistent certificate, changed-DR rejection, wrong-P12
  rejection, absent CI credentials rejection, child failure propagation and
  keychain search-list restoration. Fixtures were not launched; no TCC grants.
- CI-style base64/password import was exercised locally. After explicit user
  authorization, both `SHARECODE_MACOS_CERTIFICATE_BASE64` and
  `SHARECODE_MACOS_CERTIFICATE_PASSWORD` were saved to Actions Secrets in
  `f1sherb0y/sharecode` on 2026-10-26 at 13:40 UTC. The GitHub secret list confirmed
  both names and update timestamps; secret values cannot be read back. No commit,
  workflow run or release was triggered. Workflow changes remain local until pushed.
- Temporary signing keychains were removed; only the original login keychain
  remains in the search list. Installed production app/permissions were untouched.

Verified candidate: `build/macos-dist/0.2.2-universal-manual.McEyZ9/`.
Build log: `build/macos-certificate-build.log`. No update release was published;
this candidate omits minisign updater artifacts. The optional updater-archive
branch also enforces the identity check, but was not built in this validation.

## References

- Apple [TN3127: Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements): ad-hoc requirements are tied to a specific code version; compatible designated requirements establish identity across versions.
- Apple [Code Signing Tasks](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html): self-signed certificates can validate designated requirements, but do not establish a trusted developer identity. They do not provide Developer ID notarization or remove Gatekeeper installation warnings.
- Tauri updater 2.10.1, `updater.rs`, macOS `install_inner`: extracts the archive, backs up the existing bundle and replaces it at the same path.
