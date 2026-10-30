# One-line install commands — deployment 2026-10-30

Release `20261030-install-commands-113354` (commit `334f2e6`, branch `feature/desktop-session-client`), server and frontend,
deployed with user authorization to `dmit-us`, now at **154.17.21.29** (the server moved from
64.186.229.171 on 2026-10-29; `~/.ssh/config` and the host Caddy already follow it). It replaces
`20261029-guest-language-080613` (`1cabf3a`). No migration (29/29); PostgreSQL, Piston and
Caddy unchanged.

- The download button offers a one-line install command: zsh in Terminal on macOS (always shown),
  Windows PowerShell 5.1 from Win+R, cmd or PowerShell (behind 命令安装). The server renders
  `/api/client/install.sh` and `/api/client/install.ps1` with the node's origin and the newest
  installer, URL and SHA-256, per architecture.
- `ALLOWED_ORIGINS` in `docker-compose.production.yml`: `https://64.186.229.171` became
  `https://154.17.21.29` (`deploy.py` changed it with the images, so a failed switch restores
  both); the README and `docker-compose.yml` examples follow (`334f2e6`).

## Validation

- predeploy and postdeploy skipped at the user's request. Rust tests, `tsc -b`, i18n,
  client-chrome and client-releases suites passed locally; `scripts/install-script-tests/`:
  the Windows command end to end in Windows PowerShell 5.1 (4/4) and the macOS flow in a
  container with stand-ins for the macOS tools (31/31). The macOS script still needs a run on a
  real Mac (Gatekeeper, disk image, App Management, permissions, in-app update).
- `stage.py` on a restored copy of production: both scripts render for kode666.com and
  collabcode.cc with the copy's newest installers (darwin-aarch64, darwin-x86_64,
  windows-x86_64), UTF-8 text, never cached; the earlier guest checks pass; the previous image
  started on the copy.
- `deploy.py`: verified dump (87 MB, also in `/root/sharecode-backups`); switched in 11.5 s; the
  new server's `ALLOWED_ORIGINS` holds the new IP only. `verify-assets.py` (now also checking
  both scripts) passed on the four domains and https://154.17.21.29; no server errors. CORS
  answers https://154.17.21.29 and no longer the old IP.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261030-install-commands-113354/rollback.py'` (it also restores the
compose file, so `ALLOWED_ORIGINS` would go back to the old IP).
