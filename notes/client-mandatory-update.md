# Mandatory client updates (0.2.7)

The client opens straight away and checks for an update in the background (since
the MyGo branch; 0.2.7 blocked the first render on that check). Nothing is shown
while the check runs or when it fails. An
available release replaces all client UI (including title-bar tools and portals),
downloads automatically, and shows a progress bar. Unknown lengths use an
indeterminate bar. Only successful completion of Tauri's signature-verifying
`download()` enables **Restart to update / 重启以更新**.

The six-hour and reconnect checks use the same gate. Discovering an update in an
open session unmounts the room, whose provider cleanup disconnects collaboration.
The saved guest seat remains in storage for the new version. No install occurs
until the restart button is clicked.

Once an update is known, download and signature errors keep features blocked with
retry. A failed check leaves a client without a known update alone, and
a verified download remains installable if a recheck fails. An explicit no-update
response discards the downloaded release and reopens the app (release withdrawal).
Installation errors allow retry; if installation succeeded but restart failed,
retry runs only the restart, since Tauri already consumed the downloaded bytes.

`update_gate.rs` starts locked, prevents enabling click-through, stops macOS
shared output and Windows meeting filtering, and shows an interactive main window.
The updater screen is opaque regardless of the room's saved opacity. On macOS the
update screen does not require Input Monitoring/Screen Recording or mark the normal
permission gate complete; after no-update, the existing permission flow resumes.
The separate permission-helper window does not run an updater.

Validation:

- `node --test tests/client-chrome.test.mjs tests/i18n.test.mjs` (in `frontend`):
  client UI regression coverage plus seven updater flows using mocked native IPC:
  launch before seat restoration; known/unknown download size; verification before
  restart; network/signature failures and retries; replacement of an open room and
  its portals; install/relaunch failures; release withdrawal; macOS missing permissions.
  English/Chinese screenshots at 480×360 are under `.cache/client-chrome-chromium/`.
- `bun run client:build`: TypeScript, production build and client bundle scope guard.
- `cargo test --manifest-path frontend/src-tauri-client/Cargo.toml --locked --lib`:
  Windows native compilation and existing unit tests (live meeting tests stay ignored).

The browser tests exercise the real React gate and Tauri JS updater API through
mocked IPC; they do not replace a signed installer end-to-end test or verify native
macOS window behavior. Release CI builds both native platforms and verifies/signs
the distribution artifacts. Existing 0.2.6 clients retain their earlier optional
update UI until they install this version.
