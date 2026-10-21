# Room language deployment — 2026-10-21

Release `20261021-room-language-194404` (commit `a510f9e`, branch `schedule-tour`), server and frontend,
deployed with user authorization to `dmit-us` at about 11:47 UTC. It replaces
`20261020-settled-002343` (`c14530d`). No migration; PostgreSQL, Piston and the container
Caddy were not changed.

## What changed

- Anyone who edits a live room switches its language, a tech on an editing link included;
  read-only members, guests and outsiders still cannot, and the name, sharing and ending stay
  with the owner and staff.
- Enter that confirms an input method's composition (pinyin) no longer saves a 名单 rename or
  picks a table or customer; a rename saves at most once and Escape never saves.

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request. Rust tests, the
  schedule, role-permission and language (runner-permissions, with Piston) suites passed on
  `a510f9e` in Chromium, Firefox and WebKit (`checks/schedule.log`).
- `stage.py` on a restored copy of production (52 accounts): migrations 27/27; a tech on an
  editing link switches the language but cannot rename the room, and on a read-only link
  cannot switch it; earlier work-table, link, merge, 管理, list, settled-session and rename
  checks; rooms 1448/1441/191 and replay; the previous server started on the same copy. The
  rehearsal was adjusted for production data: the tech it signs in as (now `mock`) has its
  own table link (kept on merge, as designed), renamed itself this week (reset on the copy)
  and has a real session where a check books one (that check now saves anyway).
- `deploy.py` took a verified dump (71 MB, also in `/root/sharecode-backups`) and switched
  in 11.4 s; `verify-assets.py` passed on all four domains; no server errors or restarts.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261021-room-language-194404/rollback.py'`
