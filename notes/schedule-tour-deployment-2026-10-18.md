# Schedule calendar deployment — 2026-10-18

Release `20261018-schedule-tour-144424` (commit `f7f9793`, branch `schedule-tour`),
server and frontend, deployed with user authorization to `dmit-us` at 14:53 UTC.
PostgreSQL, Piston and the container Caddy were not changed (same containers before
and after). It replaces `20261018-scheduling-093224` (`9427db0`).

## What changed

- Agent tour of the schedule page, shown once per account (`User.seenTours`,
  `GET /api/tours`, `PUT /api/tours/{id}`).
- Calendar: time zone switch (China, Eastern, Pacific, UK, Central European); the
  app's own date and time pickers, shared with new rooms; full width and height;
  sessions colored by the customer's 管理, cards reading customer / tech · 管理 /
  company · position.
- Week and day timelines show a window of hours that is dragged sideways (also
  swipe, Shift+wheel, arrow keys), with a dashed line at the zone's midnight and
  edge markers for sessions beyond it; switching the zone keeps the window in place.
- Planning on the calendar needs **添加**; the tech picker shows one tech's
  sessions (whatever "Only mine" says) with the unassigned strip above; month
  entries name the tech.
- The UI calls agents 管理 (Manager) and the admin 超级管理员 (Super admin); role
  values are unchanged.
- Migration `202610190001_seen_tours` (21 → 22) ran in 20 ms at server start.

## Validation

- `just predeploy` on `f7f9793`: 15/15 checks passed (`predeploy-logs/`). At the
  user's request the switch did not wait for the last five (workspace-chromium,
  -firefox, -webkit, sarasa-fonts, session-export; recorded as skipped in
  `deployed.json`); they passed minutes after it.
- `stage.py` ran the built server image against a restored copy of production:
  22/22 migrations, `seenTours` empty for all 34 accounts, the tours API (once per
  account, unknown tours refused), a scheduling round trip whose session names the
  customer's 管理, one tech's sessions by `techId`, room visibility (super admin
  1362, 管理 1357, tech 186) and replay of an existing room.
- `deploy.py` checked the live files were the previous release's, took a verified
  final dump, switched in 11.5 s and confirmed 22/22 migrations.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com,
  www.kode666.com and 64.186.229.171: HTML and 22 assets match the image, the new
  bundle is present, 中介 is gone, registration is invite-only, API and runner are
  healthy.
- `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc,
  kode666.com and the IP. No errors or warnings in the server log after the switch.

## Backups

`backup/pre-deploy.dump` in the release directory, also at
`/root/sharecode-backups/sharecode-20261018-schedule-tour-144424-pre-deploy.dump`.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261018-schedule-tour-144424/rollback.py'`

It stops the server, removes migration `202610190001` and the `seenTours` column (the
previous server refuses to start with a migration it does not know), restores the
previous source files and brings back `sharecode-server:20261018-scheduling-093224`
and `sharecode-frontend:20261018-scheduling-093224`. Data written since the switch
stays; only which tours were seen is lost. It refuses to run once a newer release
has been selected.
