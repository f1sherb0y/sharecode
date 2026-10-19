# Calendar zoom deployment — 2026-10-19

Release `20261019-week-zoom-011515` (commit `3f88a3c`, branch `schedule-tour`), frontend only,
deployed with user authorization to `dmit-us` at 01:28 UTC. The server
(`sharecode-server:20261018-schedule-tour-144424`), PostgreSQL (22 migrations),
Piston and the container Caddy were not changed. It replaces the frontend of
`20261018-schedule-tour-144424` (`f7f9793`).

## What changed

- The week is days down the page without end and without a scrollbar (a virtual
  list); the day view's hours drag on through the days, with the date where a day
  begins. Both show the whole day at first; Ctrl and the wheel (or a pinch) zoom the
  hours down to two hours, and dragging, Shift+wheel or the arrow keys move them
  (within the day in the week). Edge markers count sessions outside the hours.
- A red line for now down the whole calendar; Reset brings back today and the whole
  day; timelines load a UTC week at a time; unassigned sessions are striped.
- Session cards are four lines: 管理, customer, tech, company · position.
- Zone and view switches show in one frame.

## Validation

- `just predeploy` on `3f88a3c`: 15/15 checks passed (`predeploy-logs/`).
- `deploy.py` checked the live files were `f7f9793`'s and switched the frontend in
  0.8 s; server, postgres, piston and caddy containers unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com and
  www.kode666.com (HTML and assets match the image, new bundle present, API and runner
  healthy, 22 migrations).
- `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc and
  kode666.com.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261019-week-zoom-011515/rollback.py'`

It restores the previous source files and brings back
`sharecode-frontend:20261018-schedule-tour-144424`. No data is involved.
