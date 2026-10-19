# Settled sessions deployment — 2026-10-20

Release `20261020-settled-002343` (commit `c14530d`, branch `schedule-tour`), server and frontend,
deployed with user authorization to `dmit-us` at about 16:30 UTC on 2026-10-19. It replaces
server `20261019-roster-224758` and frontend `20261020-busy-self-000909`. No migration;
PostgreSQL, Piston and the container Caddy were not changed.

## What changed

- Twelve hours after a session or busy time ends, only 超级管理员 plan, change, move or delete
  it (`403 Past sessions are locked`, also for times moved or planned there). Others see it
  read-only and cannot drag it on the full calendar.
- On the work table, dragging over free time with a mouse or pen picks the new session's or
  busy time's range (15-minute steps); a click still proposes an hour. Touch keeps scrolling.

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request (a started
  predeploy run was stopped). Rust tests, the schedule suite (with settled-session checks) and
  the role-permission suite passed on `c14530d` in Chromium, Firefox and WebKit
  (`checks/schedule.log`).
- `stage.py` on a restored copy of production (46 accounts): migrations 27/27; an agent can
  neither plan, move into, change nor delete a session more than 12 hours past, a tech cannot
  mark busy time there, the admin can; earlier work-table, link, merge, 管理, list and rename
  checks; rooms 1380/1375/60 and replay; the previous server started on the same copy.
- `deploy.py` took a verified dump (67 MB, also in `/root/sharecode-backups`) and switched
  in 11.5 s; `verify-assets.py` passed on all four domains; no server errors or restarts.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261020-settled-002343/rollback.py'`
