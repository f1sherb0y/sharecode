# Room privacy, device history and audit deployment

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Release: `20260917-privacy-audit-093447`.
- Images: `sharecode-server:20260917-privacy-audit-093447` and `sharecode-frontend:20260917-privacy-audit-093447`.
- Source: working tree snapshot based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`; SHA-256 manifest covers 182 build-source files. No commit or push was requested for this deployment.
- Includes private-room visibility and persistent higher-role nonprivate share/replay grants; deleted-room access guards and stricter delegation; device history restricted to superuser; expanded transactional audit; timestamp pagination and local datetime range picker. Admin audit responses redact device ID/fingerprint/new-device status and reject device filters; admin frontend device controls are hidden.
- Both SQLx migrations completed: `202609170001_private_rooms` and `202609170002_audit_devices`.

## Verification

- Production images built from the staged source; nginx configuration validated.
- PostgreSQL custom-format backups taken before validation and immediately before switching; both archive catalogs verified. Initial backup restored into an isolated temporary database, and the built API successfully applied migrations and passed device permissions, audit redaction, private-room access, persistent shared replay and revocation checks. Temporary API/database removed afterward.
- Production authenticated read-only checks passed for existing superuser/admin/user accounts. No test users, rooms or logins were created in the production database by smoke checks.
- Public HTML and 15 initial/lazy JS/CSS assets matched deployed image bytes. HTML has no-cache/no-store headers. Public runner health passed; unauthenticated room access denied.
- Chromium, Firefox and WebKit passed public desktop light and mobile 3x-DPI dark login/autofill/assets/layout checks, with no page/resource errors.
- PostgreSQL, Piston and Caddy retained their previous container IDs. Production source synchronized and hash-verified.
- Local prior checks: frontend production build, 17 Rust tests, private-room REST/WS/browser matrix, audit/device permissions and transactional tests, existing share/admin-pagination regressions.
- Validation harness corrections during staging: existing superusers prevent bootstrap from creating a new fixture account, so the isolated clone fixture was registered/promoted explicitly; HTTP cache verification now combines multiple Cache-Control headers. These affected only verification helpers, not application source or the running production version.

## Artifacts and rollback

Remote: `/root/sharecode-releases/20260917-privacy-audit-093447/` contains source/manifest, build logs, validation records, backups, prior Compose/source/container inventory, deployment record and verification report. Local pointer: `/tmp/sharecode-privacy-release`.

Do **not** roll the API back to a version lacking private-room and share-grant enforcement. Retain this API and fix forward if needed. Database backups are recovery artifacts and are not automatically restored over newer user data.

A guarded frontend-only rollback preserves the privacy-aware API:

```sh
ssh dmit-us 'bash /root/sharecode-releases/20260917-privacy-audit-093447/rollback-frontend.sh'
```

It restores frontend `20260917-selection-ui-081949` and its source, while keeping this API and all application data. Refuses if either selected image has since changed.
