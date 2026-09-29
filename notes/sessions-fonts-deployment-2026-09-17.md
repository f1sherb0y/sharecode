# Persistent login, fonts and release checks — 2026-09-17

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Release: `20260917-sessions-fonts-153315`.
- Images: `sharecode-server:20260917-sessions-fonts-153315` and `sharecode-frontend:20260917-sessions-fonts-153315`.
- Source: tested working tree based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`; 191 build files and 38 test/workflow files are SHA-256 manifested. No Git commit or push was made.
- Includes persistent HttpOnly browser sessions, 15-minute access tokens and renewal while editing, independent device logout, Sarasa Mono via CDN, lazy loading/cache improvements, slightly larger UI/editor fonts and the larger navbar brand (28px icon, 18px text).
- Migration `202609170003_browser_sessions` applied successfully. Existing privacy/audit migrations remain applied. PostgreSQL, Piston and Caddy containers were not recreated.

## Required checks retained in the repository

`just predeploy` runs Rust unit tests, the production frontend build, real three-engine browser-restart sessions, editing/renewal, the three-engine workspace/mobile/DPI suites, Sarasa loading/fallback and standalone export regressions. Failures stop the gate and retain logs. `just postdeploy [url]` runs anonymous public checks. Instructions are in AGENTS.md, README.md and DEPLOYMENT.md; neither command deploys.

This release passed all checks. The first export run stalled under Bun after entering Firefox; the original failed logs are retained. The test now keeps FontFace host objects in the browser, explicitly bounds/checks CJK loading, and runs Playwright under Node (Bun only transpiles the TypeScript fixture). The affected complete export suite was rerun successfully on Chromium, Firefox and WebKit; other previously passing checks and application sources were unchanged. The release switch requires a complete passing check record.

## Deployment validation

- Built both production images and checked nginx configuration.
- Took a custom-format PostgreSQL backup, verified its catalog, restored it into a temporary database, and validated the built API/migration there. Production cookie flags, restore/refresh, CSRF, device-independent logout, role/device-audit restrictions, private-room visibility and shared replay/revocation passed. Temporary database/container removed.
- Took and catalog-verified a second database backup immediately before switching.
- Public HTML and 17 initial/lazy assets matched the new image. HTML is not cached. API unauthenticated access is denied, runner health is healthy, and authenticated read-only checks passed for existing superuser/admin/user roles.
- `just postdeploy` passed Chromium, Firefox and WebKit at desktop/light and phone/dark/3x DPI: login rendering, password autofill attributes, system theme, no horizontal overflow, anonymous refresh rejection and runner health. No production accounts, logins, rooms or session records were created by smoke checks.

## Artifacts and recovery

Remote release directory: `/root/sharecode-releases/20260917-sessions-fonts-153315/`.
Contains source/test archives and manifests, build/staging/switch/verification logs, original and rerun predeployment results, public browser screenshots/results, prior Compose/source inventories and protected database backups.

Keep the session-aware API when fixing forward: the previous API does not enforce per-device session revocation. Do not restore a database backup over newer user data as a routine rollback. Previous image references and source backups are retained for controlled recovery.
