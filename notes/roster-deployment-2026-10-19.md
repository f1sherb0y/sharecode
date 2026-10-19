# Lists deployment — 2026-10-19

Release `20261019-roster-224758` (commit `f4c09e2`, branch `schedule-tour`), server and
frontend, deployed with user authorization to `dmit-us` at about 14:50 UTC. It replaces
`20261019-usernames-124550` (`436a6d4`). PostgreSQL, Piston and the container Caddy were
not changed.

## What changed

- Work tables get two lists (名单, "···" menu, staff; migration `202610200005` adds
  `RosterEntry`: 26 → 27). Each name stands for an account or a placeholder nobody signs
  in as; 关联账号 merges a placeholder into an account. Staff see only listed techs'
  tables, sessions offer only listed 管理 (a new work-table session needs one), and cards
  and session JSON use the list names. New work tables join the end of the techs' list.
- Placeholders no longer sign in, and are left out of room-owner choices.
- The lists were seeded as agreed (`seed.sql`, `roster.json`):
  - techs: 可可西里 (placeholder), des → Destiny, since → since, jin → jinzz, 666 → 666,
    kk → kkksx, tre → Tres, 林霏开 → linfeikai, haji → haji;
  - 管理: 秋莲, 秋来, apex, 懒洋洋 (placeholders), hjq → HJQ, 仲东初五, lip, aes,
    幕云树下, T (placeholders).

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request. Rust tests,
  the schedule suite (with list checks) and the role-permission suite passed on `f4c09e2`
  in Chromium, Firefox and WebKit (`checks/schedule.log`, required by `deploy.py`).
- `stage.py` on a restored copy of production (36 accounts): migrations 27/27, the seed
  applied and read back in order; staff see exactly the nine listed tables; a new table
  joins the list and leaves it when merged; sessions carry list names for tech and 管理;
  placeholders do not sign in; techs get 404 on `/api/roster`; earlier work-table, link,
  merge, 管理 and rename checks; rooms 1379/1374/60 and replay; rollback rehearsed with
  the previous image.
- `deploy.py` took a verified dump (67 MB, also in `/root/sharecode-backups`), switched in
  11.5 s and seeded the lists; `verify-assets.py` passed on all four domains; no server
  errors or restarts.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-roster-224758/rollback.py'`

It saves the lists to `backup/rollback-removed.json`, drops `RosterEntry`, soft-deletes the
ten seeded placeholders (`rollback.sql`) and brings back the `20261019-usernames-124550`
images.
