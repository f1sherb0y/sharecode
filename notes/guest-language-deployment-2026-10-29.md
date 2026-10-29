# Editing guests switch the room language — deployment 2026-10-29

Release `20261029-guest-language-080613` (commit `1cabf3a`, branch `feature/desktop-session-client`), server and frontend,
deployed with user authorization to `dmit-us`. It replaces `20261025-landing-rooms-053817`
(`bdde6d2`). No migration (29/29); PostgreSQL, Piston and Caddy unchanged.

- Share guests whose link lets them edit the live room switch its language (`PUT /api/rooms/{id}`
  now takes guest tokens, language only; anything else and read-only guests get 403). The web
  editor shows them the language picker.
- Running code was already open to everyone who can write (accounts run anywhere, editing guests
  in their room); unchanged.
- The branch's desktop-client commits since `bdde6d2` only touch the client bundle and add
  client strings to the shared locale files; the web bundle is otherwise unchanged.

## Validation

- predeploy and postdeploy skipped at the user's request. Rust tests, `tsc -b` and the language
  part of `runner-permissions` (API and Chromium picker, editing/read-only guests) passed locally;
  its Piston part was not run locally.
- `stage.py` on a restored copy of production: an editing guest switched the language (reply
  without the owner), was refused a rename or company change, a read-only guest was refused,
  guests still run code through the real Piston (42), read-only guests 403; the previous image
  started on the copy.
- `deploy.py`: verified dump (84 MB, also in `/root/sharecode-backups`); switched in 11.6 s.
  `verify-assets.py` passed on the four domains and https://64.186.229.171; no server errors.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261029-guest-language-080613/rollback.py'`
