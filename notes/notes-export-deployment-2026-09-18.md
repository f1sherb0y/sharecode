# Notes permissions and export deployment — 2026-09-18

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Release: `20260917-notes-export-175432` (UTC release identifier).
- Images: `sharecode-server:20260917-notes-export-175432` and
  `sharecode-frontend:20260917-notes-export-175432`.
- Source: working tree snapshot based on
  `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`; 192 build files and 42 verification
  files recorded with SHA-256 hashes. Seventeen application files differ from the
  previous release. No commit or push was made.
- Notes read access follows room read access; mutations follow room edit access,
  including share guests. Existing private/ended/revoked-room restrictions apply.
  Readable session exports retain notes. Login/register branding is larger.
- No new database migration. Existing migrations verified successful.

`just predeploy` passed all 11 checks, including notes API permission matrices,
actual reader/manager HTML downloads, browser-process restart login, token renewal,
all three full workspace UI suites, fonts and standalone HTML playback. Local
gate logs: `/tmp/sharecode-predeploy.vXuLCh`.

Both production images were built from the manifested snapshot. A production
database backup was restored into a temporary database to validate the actual
API image, cookie settings, privacy, notes permissions and readable replay data.
The validation container/database were removed. A second catalog-verified backup
was taken immediately before switching. PostgreSQL, Piston and Caddy were not
recreated.

After deployment, public HTML and 20 initial/lazy assets matched the frontend
image. HTML cache policy, anonymous authorization rejection and runner health
passed. `just postdeploy https://collabcode.cc` passed Chromium, Firefox and WebKit
on desktop/light and mobile/dark/3x DPI, including autofill and system theme.
Public smoke checks created no accounts, rooms or authenticated sessions.

Remote artifacts, protected database backups, previous Compose/source inventory,
build logs, test logs and public screenshots:
`/root/sharecode-releases/20260917-notes-export-175432/`.

Previous image tags: `20260917-sessions-fonts-153315`. Retain these for recovery;
do not restore an old database over newer user edits as a routine rollback.
