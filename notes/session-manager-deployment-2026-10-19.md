# Session manager deployment — 2026-10-19

Release `20261019-session-manager-121508` (commit `d189cc6`, branch `schedule-tour`),
server and frontend, deployed with user authorization to `dmit-us` at about 12:20 UTC.
It replaces `20261019-work-tables-115414` (`0a412d6`). PostgreSQL, Piston and the
container Caddy were not changed.

## What changed

- Both session forms pick the 管理 a session belongs to (agents and admins by name). The
  work table's form defaults to whoever books and no longer asks for a customer; the full
  calendar's follows the customer's agent until one is picked by hand.
- Cards, colors, 只看我的, the 我的 badge and conflict messages follow that 管理
  (`manager` in the API); sessions without one keep the customer's agent, else the planner.
  A new 管理 alone sends the tech no notice.
- Phones: the table chip and the zone get a row of their own; long names end in "…".
- Migration `202610200003` adds `Appointment.managerId`: 24 → 25.

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request. Rust tests and
  the schedule suite passed on `d189cc6` in Chromium, Firefox and WebKit
  (`checks/schedule.log`, which `deploy.py` required).
- `stage.py` on a restored copy of production: migrations 25/25, no 管理 chosen on existing
  sessions, a session handed to Aurora (theirs under 只看我的), a tech refused as 管理, every
  session with a 管理; work tables, links and merging as before; rooms 1374/1369/185 and
  replay; then `rollback.sql` and the previous server image on the copy.
- `deploy.py` took a verified dump (67 MB, also in `/root/sharecode-backups`), checked the
  live files were `0a412d6`'s and switched in 11.3 s; postgres, piston and caddy unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com and
  www.kode666.com. No server errors or restarts after the switch.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-session-manager-121508/rollback.py'`

It saves the chosen 管理 to `backup/rollback-removed.json`, drops `managerId`
(`rollback.sql`) and brings back the `20261019-work-tables-115414` images; sessions stay.
