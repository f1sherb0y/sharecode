# Multi-origin access deployment — 2026-09-29

Release `20260929-multi-origin-180227` (commit `b6d24e1`), server only. Frontend
`sharecode-frontend:20260919-recovery-180225`, PostgreSQL, Piston and the
container Caddy were not changed.

## What changed

- Host Caddy (`/etc/caddy/Caddyfile` on dmit-us) serves the app directly on
  `collabcode.cc`, `www.collabcode.cc`, `kode666.com`, `www.kode666.com` and
  `https://64.186.229.171`. The old www→apex redirect is gone. The IP uses a Let's
  Encrypt `shortlived` certificate (6-day validity, renewed automatically), and
  `default_sni 64.186.229.171` covers browsers that send no SNI for IP literals.
  Backup: `/etc/caddy/Caddyfile.before-multi-origin-20260929-095947`.
- Server: new `ALLOWED_ORIGINS` (exact origins, comma-separated) is accepted by
  CORS and by the CSRF origin checks for login, register, refresh and logout.
  Production value:
  `https://www.collabcode.cc,https://kode666.com,https://www.kode666.com,https://64.186.229.171`
  (`https://collabcode.cc` comes from APP_URL/FRONTEND_URL). Keep it in sync
  with the host Caddy site list.

## Behaviour

- Web share links use the current page origin, and joining is by token only, so
  `/s/<token>` works on any listed host and keeps working if the host is swapped.
  Server-generated `shareUrl` (the Tauri client) still uses APP_URL
  (`https://collabcode.cc`).
- The session cookie `__Host-sharecode-session` is host-scoped, so signing in on
  one host does not sign you in on the others.

## Validation

- `just predeploy`: all 12 checks passed
  (logs are in `predeploy-logs/` in the release directory).
- `stage.py` ran the built image against a restored copy of the production
  database. For every origin it checked CORS preflight and login → refresh →
  logout, confirmed that look-alike origins are rejected, that the session header
  is required, that cookie flags are unchanged and that shareUrl uses APP_URL.
- `deploy.py` confirmed health, left every other container unchanged and found
  17/17 migrations successful.
- `verify.py` checked every host for the app page, the `/s/` route, API auth
  enforcement, CORS for the host's own origin, and rejection of untrusted origins.
- `verify-assets.py <host>`: on all five hosts, the public HTML and 20 assets
  match the image, and the runner is healthy.
- `just postdeploy` on collabcode.cc, kode666.com and 64.186.229.171 passed in
  Chromium, Firefox and WebKit.

## Rollback

`python3 /root/sharecode-releases/20260929-multi-origin-180227/rollback.py` restores the previous server
image, the compose file and the two source files. It refuses to run if the server
release has changed since. Restore the host Caddy backup separately if that is
needed too.

## Follow-up release: 20260929-follow-192323 (frontend only)

Commit `381225f`: status-bar "Allow follow" opt-out for code, Markdown and
Canvas rooms, plus the fix for Canvas follow being cancelled when Canvas remounts.
Server image is unchanged (`20260929-multi-origin-180227`).
`just predeploy` passed 13/13 checks (including the new follow-permission check).
`verify-assets.py` passed on all five hosts (20 assets each), and
`just postdeploy` passed on collabcode.cc, kode666.com and the IP in all three
browsers. Rollback: `python3 /root/sharecode-releases/20260929-follow-192323/rollback.py`
(restores `sharecode-frontend:20260919-recovery-180225`).
