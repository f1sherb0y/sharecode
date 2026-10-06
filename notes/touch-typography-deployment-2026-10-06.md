# Touch typography deployment — 2026-10-06

Release `20261006-touch-type-040554` (commit `2ea0c1b`, pushed to `origin/master`),
frontend only, deployed with user authorization to `dmit-us`. Server
`sharecode-server:20260929-multi-origin-180227`, PostgreSQL, Piston and the
container Caddy were not changed (same container IDs before and after).

## What changed

- One touch type scale (`@media (pointer: coarse)` in `globals.css`): dialog
  title 19px, card titles and field values 16px (iOS zoom floor), labels/buttons/
  body 13px, hints 12px. Full-size select triggers count as fields; compact
  toolbar/table selects (`h-control-sm`) keep their size. Hooks are the new
  `ui-label`, `ui-dialog-title`, `ui-dialog-header` and `ui-card-title` classes.
- `Label` is now `block`, so the `space-y-1` label→field gap declared by every
  form applies (it measured 0px before; desktop gains the same 4px). The join
  page's one-off `pb-1.5` was removed.
- Create Room drops its forced 12px labels/inputs/select and uses 8px group spacing.
  "Make room private" is one tappable `ui-check-row` (box + title + hint); the
  checkbox is named by the title and described by the hint.
- The editor status-bar language select sizes to its content (the fixed 84px
  clipped "typescript").

## Validation

- `just predeploy` on `2ea0c1b`: 13/13 checks passed
  (`predeploy-logs/` in the release directory).
- Before the gate: three-browser workspace UI suites, `private-rooms` and
  `follow-permission` against disposable databases, plus touch/desktop measurements
  of every form (label size, label→field gap, field size).
- The release manifest (195 files) was built from the commit; only the 7 committed
  files differ from `20260929-follow-192323`.
- `deploy.py` rebuilt only the frontend, passed `nginx -t`, recreated only that
  container, and confirmed every other service unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com,
  www.kode666.com and 64.186.229.171: HTML and 20 assets match the image, the
  new touch rules, check row and auto-width select are present, 17/17
  migrations succeeded, and API/runner health is OK.
- `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc,
  kode666.com and the IP.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261006-touch-type-040554/rollback.py'`
restores `sharecode-frontend:20260929-follow-192323` and the 7 source files
in `/root/sharecode.work`. It refuses to run if a newer frontend release has been selected.
The follow-up release below has replaced it, so roll that one back first.

## Follow-up release: 20261006-touch-15px-091535 (frontend only)

Commit `ba2b886` (pushed to `origin/master`). The server image is unchanged
(`20260929-multi-origin-180227`).

- Every touch control is 15px: fields, select triggers, buttons, and menu/select
  items (dropdown options were 13px next to 16px fields). Page titles (the
  "Workspace" heading, navbar titles) join card titles at 16px via `ui-page-title`.
  The editor status bar and compact `h-control-sm` selects keep their dense sizes.
- iOS zooms into fields under 16px on focus. An inline script in `index.html`
  adds `maximum-scale=1` only when `CSS.supports('-webkit-touch-callout', 'none')`
  (iOS); WebKit ignores it for pinch-zoom since iOS 10. Other browsers keep full
  page zoom. Not tested on a real iPhone (no simulator on the Linux build host).
  Note: an in-app WKWebView may honour `maximum-scale` and block pinch-zoom.
- `NavbarBack` (settings, notifications, admin, audit) shows only the arrow below
  `sm`; the label stays the accessible name. Centered navbar titles truncate
  instead of wrapping ("管理后台" wrapped at 320px).

Validation: `just predeploy` passed 13/13 on `ba2b886`. Of the 195 manifest
files, only the 9 committed ones differ from `20261006-touch-type-040554`.
`deploy.py` recreated only the frontend container. `verify-assets.py` passed
on all five hosts (20 assets each, 17/17 migrations), with the release's checks
for the 15px rules, the iOS zoom guard and the navbar back/title change replacing
the previous 16px checks. `just postdeploy` passed in Chromium, Firefox and
WebKit on collabcode.cc, kode666.com and the IP.

Rollback: `ssh dmit-us 'python3 /root/sharecode-releases/20261006-touch-15px-091535/rollback.py'`
restores `sharecode-frontend:20261006-touch-type-040554` and the 9 source files.
The guest-follow release below has replaced it, so roll that one back first.

## Follow-up release: 20261006-guest-follow-094314 (frontend only)

Commit `5ed5d09` (pushed to `origin/master`). The server image is unchanged
(`20260929-multi-origin-180227`).

- Guests always publish `followable: true` and get no "Allow follow" toggle.
  The preference is stored in origin-wide `localStorage`, so before this a guest
  in a browser where an account had opted out was silently unfollowable, with no
  way to change it. Accounts keep the toggle and their stored preference.
- Status bar order: language | font controls | users list, then "Allow follow"
  (accounts only) next to the users list.

Validation: `follow-permission.mjs` gained a guest pass in all three engines: the
guest joins via a real share link with "Allow follow" stored off, has no toggle,
an account can still follow them, and the users list sits right of the font
controls. The pass fails on the previous editor and also when only the toggle is
hidden. `just predeploy` passed 13/13 on `5ed5d09`. Only
`frontend/src/pages/editor.tsx` differs from `20261006-touch-15px-091535` among
the 195 manifest files. `deploy.py` recreated only the frontend container.
`verify-assets.py` passed on all five hosts (20 assets each, 17/17 migrations).
It keeps the 15px checks and adds checks for the guest followable override, the
guest-hidden toggle and the font-before-users order. `just postdeploy` passed in
Chromium, Firefox and WebKit on collabcode.cc, kode666.com and the IP.

Rollback: `ssh dmit-us 'python3 /root/sharecode-releases/20261006-guest-follow-094314/rollback.py'`
restores `sharecode-frontend:20261006-touch-15px-091535` and `editor.tsx`.
