# Client releases deployment — 2026-10-24

Release `20261024-client-releases-194224` (commit `755ad32`), server and frontend, deployed
with user authorization to `dmit-us` at about 12:44 UTC. It replaces
`20261021-room-language-194404` (`a510f9e`). Migration 28 (`202610250001_client_releases`);
PostgreSQL, Piston and the Caddy containers were not replaced.

## What changed

- 管理后台 → 客户端发布: admins publish versions of the customer desktop client (drafts, files
  per platform, publish and unpublish; audited as `client_release.*`). Uploads are checked
  against the client's update signing key, as the client's updater checks them.
- The login and join pages offer the newest installer for the visitor's system; nothing shows
  until a version is published.
- `/api/client/update/{target}/{arch}/{version}` answers the desktop client's updater (Tauri's
  dynamic update format; 204 while nothing newer is published).
- Bold text and section titles in Markdown documents are coloured (emphasis orange, heading
  blue).
- Production configuration: the server keeps installers on the new volume
  `sharecodework_client_releases` (`CLIENT_RELEASES_DIR=/data/client-releases` in
  `docker-compose.production.yml`), and the container Caddy (`Caddyfile.production`) accepts
  bodies up to 513 MiB on `/api/admin/client-releases/*/assets` only; everything else keeps
  the 10 MB limit. The host Caddy has no body limit and was not changed.

## Validation

- `just predeploy` passed all 16 checks on `755ad32` (`checks/` in the release directory). It
  ran in `mcr.microsoft.com/playwright:v1.62.1-noble` on a clean clone: the suites assume
  Linux. A run on Windows first found three suites that cannot pass there, the same on
  master (fixed in `f727436`: a reconnect-recovery race exposed by a slow WebKit, a `/D:/…`
  spawn path in schedule, a `?` in a workspace screenshot name), and the Linux run found the
  new download-button test reading the test machine's own system (fixed in `755ad32`). Two
  more WebKit timing failures remain on Windows only (a third refresh within the
  reconnect-recovery window, the tour's seen state read before it is saved).
- `stage.py` on a restored copy of production (52 accounts): migrations 28/28; earlier
  work-table, link, merge, 管理, list, settled-session, room-language and rename checks; rooms
  1539/1532/199 and replay. The real signed 0.1.0 Windows installer went through the whole
  cycle on the copy: a tampered copy refused, upload checked against the built-in key,
  publish, the download list, updater answers with URLs on each of the five origins (unknown
  hosts get collabcode.cc), whole and ranged downloads, unpublish, delete (files removed),
  audit. Rollback rehearsal: `undo-migration.sql`, then the previous server started on the copy.
- `deploy.py` validated the Caddy change with the running image, wrote it in place and
  reloaded (limits 10 MB and 513 MiB confirmed); took a verified dump (77 MB, also in
  `/root/sharecode-backups`); switched in 11.3 s with no edits in the 10 minutes before;
  migrations 28/28, the volume mounted, `/api/client/releases/latest` empty.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com, www.kode666.com
  and 64.186.229.171 (25 assets each, release markers, Markdown colours, 401/404/204 on the
  new endpoints). `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc and
  kode666.com. No server errors or restarts after the switch.
- Caddy (both layers run `encode gzip zstd`) leaves `application/octet-stream` uncompressed,
  so installer downloads keep their length and byte ranges.

## Not done

No client version is published yet. To publish the first one, build it with the signing key
(BUILD.md) and upload it in 客户端发布; the signed 0.1.0 Windows installer built on
2026-10-24 is ready.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261024-client-releases-194224/rollback.py'`

It stops the server, dumps the client release tables to `backup/client-releases.sql`, undoes
migration 28, restores the compose file and `Caddyfile.production` (reloading Caddy) and starts
the previous images. The installer volume is kept.
