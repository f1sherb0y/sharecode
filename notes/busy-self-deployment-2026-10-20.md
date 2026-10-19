# Own busy time deployment — 2026-10-20

Release `20261020-busy-self-000909` (commit `5712bb6`, branch `schedule-tour`), frontend
only, deployed with user authorization to `dmit-us` at about 16:10 UTC on 2026-10-19. It
replaces the `20261019-roster-224758` frontend; the server, database, Piston and Caddy were
not changed.

## What changed

- Shared table links (`/t/…`) no longer load or show announcements or schedule notices,
  even when someone is signed in on the browser.
- Staff get the 标记占用 toggle on their own work table; while it is on, clicks and + mark
  their busy time instead of booking.

## Validation

- `just predeploy` and `just postdeploy` were skipped at the user's request. Rust tests, the
  schedule suite and the role-permission suite passed on `5712bb6` in Chromium, Firefox and
  WebKit (`checks/schedule.log`). Both changes were checked by hand in a headless browser.
- `deploy.py` switched the frontend in 1.9 s; `verify-assets.py` passed on all four domains.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261020-busy-self-000909/rollback.py'`
