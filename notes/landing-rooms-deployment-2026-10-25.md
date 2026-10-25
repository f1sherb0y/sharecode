# Landing page rooms button — deployment 2026-10-25

Release `20261025-landing-rooms-053817` (commit `bdde6d2`), server and frontend, deployed with user authorization to
`dmit-us`. It replaces `20261025-guest-run-053153` (`2121e74`). No migration (29/29).

- Signed-in accounts on `/` get **进入房间** under the logo; the navbar logo leads to `/`.
- predeploy and postdeploy skipped at the user's request. `stage.py` on a copy of production
  (editing guests still run code, read-only guests 403, the previous image starts); switched in
  11.4 s after a verified dump; `verify-assets.py` passed on all five origins; no server errors.

Rollback: `ssh dmit-us 'python3 /root/sharecode-releases/20261025-landing-rooms-053817/rollback.py'`
