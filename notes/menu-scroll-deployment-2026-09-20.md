# Rooms menu and theme deployment — 2026-09-20

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Release/frontend image: `sharecode-frontend:20260919-menu-scroll-164925` (UTC release identifier).
- Tested working tree snapshot based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`, with SHA-256 manifests for build and verification sources. No commit or push.
- Compared all 192 build files against the previous production manifest; only `frontend/src/styles/globals.css` changed. Verified no unmanifested files in application source, public assets, tooling, patches or migrations, and rechecked source hashes after the gate.
- Radix scroll locking now preserves the viewport as the sticky navbar's scroll container. Popover colors follow the theme background/foreground.
- Added long-list regression coverage for the scrolled account menu, light/dark themes, desktop/mobile layouts, Escape/focus/scroll restoration, nested dialog/select, and menu navigation. Desktop cases also verify wheel scroll locking and restoration.

`just predeploy` passed all 11 checks. All three workspace suites passed 11 tests each; browser restart authentication, session renewal, notes permissions/exports, Sarasa font/CDN fallback, and standalone replay exports also passed. Logs: `/tmp/sharecode-predeploy.VzMHCF`.

Built production frontend from the manifested snapshot and checked nginx configuration. Only the frontend container was recreated; server, PostgreSQL, Piston and Caddy container IDs/images remained unchanged. All 17 existing migrations are successful; no migration was introduced.

Public HTML and 20 initial/lazy assets match the deployed image byte for byte. Published CSS contains the scroll-lock and theme fixes. HTML cache policy, anonymous authorization rejection and runner health passed. `just postdeploy https://collabcode.cc` passed Chromium, Firefox and WebKit on desktop/light and mobile/dark/3x DPI. Public checks used no account and changed no application data.

Remote source/manifests, predeploy logs, build logs, previous Compose/source/container inventory, deployment record, verification result and browser artifacts:
`/root/sharecode-releases/20260919-menu-scroll-164925/`.

Local public smoke artifacts: `/tmp/sharecode-deployment-smoke-re4Dnr`.
Previous frontend image: `sharecode-frontend:20260917-notes-export-175432`.
Guarded frontend rollback (refuses if a newer release is selected):

```sh
ssh dmit-us 'python3 /root/sharecode-releases/20260919-menu-scroll-164925/rollback.py'
```
