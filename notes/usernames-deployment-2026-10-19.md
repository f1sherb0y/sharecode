# Usernames deployment — 2026-10-19

Release `20261019-usernames-124550` (commit `436a6d4`, branch `schedule-tour`), server
and frontend, deployed with user authorization to `dmit-us` at about 12:50 UTC. It
replaces `20261019-session-manager-121508` (`d189cc6`). PostgreSQL, Piston and the
container Caddy were not changed.

## What changed

- Anyone signed in renames themselves in Settings once a week (`PUT /api/auth/username`,
  migration `202610200004` adds `User.usernameChangedAt`: 25 → 26). The old name stops
  signing in; everything refers to accounts by ID.
- New and changed names are trimmed, 2–32 characters without spaces or control
  characters, and unique whatever their case: registration, admin-created accounts, work
  tables and renames. Existing names stay; in production only `linfeikai ` (active) and
  `baichao ` (deleted) have a trailing space, and `linfeikai ` and `linfeikai` both exist.
- Work tables: the chip opens a picker (新建工作表 first, a search, pages of eight that stay
  on screen on phones); a house at the top left goes back to the rooms (房间 left the "···"
  menu).

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request. Rust tests,
  the schedule suite and the role-permission suite (with new rename checks) passed on
  `436a6d4` in Chromium, Firefox and WebKit (`checks/schedule.log`, required by `deploy.py`).
- `stage.py` on a restored copy of production (35 accounts): migrations 26/26, no renames
  recorded; renaming refused with a space or another account's name in other case, trimmed,
  refused again within the week (429), the old name no longer signs in and the new one
  does; an admin cannot create the same name in other case; earlier work-table, link,
  merge and 管理 checks; rooms 1374/1369/185 and replay; rollback rehearsed with the
  previous image.
- `deploy.py` took a verified dump (67 MB, also in `/root/sharecode-backups`) and switched
  in 11.5 s; `verify-assets.py` passed on all four domains; no server errors or restarts.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-usernames-124550/rollback.py'`

It saves rename times to `backup/rollback-removed.json`, drops `usernameChangedAt`
(`rollback.sql`) and brings back the `20261019-session-manager-121508` images. Names
changed since stay.
