# Person picker and day rows deployment — 2026-10-19

Release `20261019-day-rows-020437` (commit `abb9971`, branch `schedule-tour`), frontend
only, deployed with user authorization to `dmit-us` at 02:07 UTC. The server
(`sharecode-server:20261018-schedule-tour-144424`), PostgreSQL (22 migrations), Piston
and the container Caddy were not changed. It replaces the frontend of
`20261019-week-zoom-011515` (`3f88a3c`).

## What changed

- The calendar's person picker lists 所有人 first, then techs, 管理 and 超级管理员 in one
  list by name; the session form's tech list has no role headings either.
- The day view gives rows only to people with sessions that day (or in the hours shown)
  and shows the unassigned row only when it holds sessions; a day without sessions has
  one unnamed row. The agent tour says so.
- Deleting a session closes both the confirmation and the form; the deleted session is
  not fetched again (no empty form, no 404).

## Validation

- `just predeploy` was skipped at the user's request. The schedule suite, the one these
  changes touch, passed on `abb9971` in Chromium, Firefox and WebKit
  (`checks/schedule.log`); `deploy.py` required that log instead of the gate results.
- `deploy.py` checked the live files were `3f88a3c`'s and switched the frontend in
  0.8 s; server, postgres, piston and caddy containers unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com and
  www.kode666.com (HTML and assets match the image, the new picker and tour text
  shipped and the old text gone, API and runner healthy, 22 migrations).
- `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc and
  kode666.com.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-day-rows-020437/rollback.py'`

It restores the previous source files and brings back
`sharecode-frontend:20261019-week-zoom-011515`. No data is involved.
