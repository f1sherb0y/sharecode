# Landing page and guest code runs — deployment 2026-10-25

Release `20261025-guest-run-053153` (commit `2121e74`), server and frontend, deployed with user authorization to
`dmit-us`. It replaces `20261024-ci-logo-205954` (`eb8a068`). No migration (29/29).

## What changed

- `/` is a landing page: the login page for anyone not signed in, only the logo (a link to the
  rooms) and the desktop client download for signed-in accounts.
- Share guests who can write to their room run code (`/api/code/execute` took account tokens
  only and answered "Invalid token"); read-only guests get 403.

## Validation

- predeploy and postdeploy skipped at the user's request.
- `stage.py` on a restored copy of production: an editing guest ran `print(6*7)` through the real
  Piston (42), a read-only guest got 403, an admin still runs code; the previous image started on
  the copy.
- `deploy.py`: verified dump (77 MB, also in `/root/sharecode-backups`); switched in 11.4 s.
  `verify-assets.py` passed on the four domains and https://64.186.229.171; no server errors.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261025-guest-run-053153/rollback.py'`
