# Work tables deployment — 2026-10-19

Release `20261019-work-tables-115414` (commit `0a412d6`, branch `schedule-tour`), server
and frontend, deployed with user authorization to `dmit-us` at 11:58 UTC. It replaces
server `20261018-schedule-tour-144424` and frontend `20261019-day-rows-020437` (`abb9971`).
PostgreSQL, Piston and the container Caddy were not changed.

## What changed

- `/schedule` opens the work tables (工作表): one table per tech, a week of sessions with
  hours down the page. 管理 book free time on it and clashes are refused; the old calendar
  moved to `/schedule/full` (完整排班 in the "···" menu). Sessions no longer need a customer.
- Techs mark busy time (占用) only with the 标记占用 button on; busy time may cover a session
  and both turn red. They pin a note above their table. A tip reads 只有管理能编辑排班.
- Share button: copies a table's 10-character link (`/t/<link>`). The link opens the table
  without signing in (note and busy time only, no customers, no rooms); 管理 signed in go on
  to the editable table; 如要编辑请登录 signs in and returns. 重置链接 stops the old link.
- 新建工作表 makes a placeholder tech (`linkOnly`) with a link; 合并到账号 moves it into a
  real account later.
- Migrations `202610200001` (`Appointment.customerId` nullable, `isBlock`,
  `User.scheduleNote`) and `202610200002` (`User.linkOnly`, `tableToken`): 22 → 24.

## Validation

- `just predeploy` passed all 15 checks on `0a412d6` (`predeploy-logs/` in the release).
- `stage.py` on a restored copy of production (35 accounts): migrations 24/24, no busy time,
  placeholders, links or notes after migrating; a session without a customer, busy time
  over it (both flagged), a refused booking over busy time, the note, a placeholder table
  with a 10-character link (no customer or room through it, busy time only, unknown link
  404), merging into the tech; rooms visible 1374/1369/185 for admin/agent/tech, replay of
  an existing room. Then `rollback.sql` on the copy and the previous server image started
  on it.
- `deploy.py` took a verified dump (67 MB, also in `/root/sharecode-backups`), checked the
  live files were `abb9971`'s and switched in 11.4 s; postgres, piston and caddy unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com and
  www.kode666.com (HTML and assets match the image, work-table text shipped, API and runner
  healthy, 24 migrations). No server errors after the switch.
- `just postdeploy` was skipped at the user's request.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-work-tables-115414/rollback.py'`

It saves busy time, sessions without a customer, notes and links to
`backup/rollback-removed.json`, removes them, undoes both migrations (`rollback.sql`) and
brings back `sharecode-server:20261018-schedule-tour-144424` and
`sharecode-frontend:20261019-day-rows-020437`. Placeholder tables stay as tech accounts
nobody can sign in as. `backup/pre-deploy.dump` holds the database as it was before.
