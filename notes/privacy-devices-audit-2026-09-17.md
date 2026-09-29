# Room privacy, device history and audit changes (local)

Deployed with user authorization in release `20260917-privacy-audit-093447`. See [deployment record](privacy-audit-deployment-2026-09-17.md) for verification, backups and rollback constraints.

## Room policy

Roles rank `superuser > admin > user`. Existing rooms default to nonprivate.

- Nonprivate rooms retain owner / active invited member / global-read visibility. Global write/delete imply read; only superuser has implicit global capabilities.
- Private rooms admit their owner, strictly higher roles, and explicit members or valid share invitations. A global flag alone cannot cross the same/lower-role privacy boundary (including superuser peers).
- Ordinary private-room members lose access on end. Higher-role viewers and otherwise entitled invited global readers retain their established administrative access.
- Logged-in users accepting a higher-role owner's nonprivate share receive a persistent, link-associated replay grant. Its edit permission comes from that share, even for globally writable accounts. Ended rooms remain read-only. Revocation removes the link-derived grant. Independent public global access remains independent.
- Existing attributable higher-role share memberships are backfilled using current owner/member roles; direct memberships do not gain replay rights. Guests and same-rank ordinary shares do not gain this exception.
- The workspace, admin room list, direct REST, WebSocket authentication/revalidation, replay/export, notes and room mutations enforce the policy. Deleted-room metadata/replay access is closed. Owner role changes revalidate existing private-room sockets.
- Restricted admins cannot create/update accounts with room capabilities they cannot themselves delegate.

## Research and choices

Reviewed upstream docs on 2026-09-17:

- [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs): installed **5.2.0**, MIT (verified installed package/license). Mature browser-only library. Self-hosted dynamic chunk; `monitoring: false` disables upstream usage telemetry. No paid identification service. Production chunk approximately 34.4 kB / 15.5 kB gzip.
- [ThumbmarkJS](https://github.com/thumbmarkjs/thumbmarkjs): MIT, client-only option; considered, but FingerprintJS has a longer track record. Both probabilistic fingerprints can collide, change or be spoofed; neither proves a physical device or its owner.
- [react-datepicker](https://github.com/Hacker0x01/react-datepicker): installed **9.1.0**, MIT. Keyboard/calendar selection, editable date and time, date-fns EN/ZH locales. Loaded with the audit route, not on normal room/login pages. Customized with existing color and control tokens.

## Device model

- First-party random browser UUID in localStorage; memory fallback when persistence is blocked.
- Fingerprint computed in browser; only the versioned hash is sent. No raw fingerprint components or third-party API calls. At most 1.5 seconds of waiting for fingerprint collection; failure does not block sign-in.
- `UserDevice` keyed by `(userId, deviceId)` stores fingerprint, user agent, first/latest successful login, latest IP, login count. Different browser IDs are never merged solely because their fingerprints match.
- Successful login and device upsert are committed with the audit event. First observed device is marked `newDevice`; failed logins do not register devices. Concurrent first logins do not create duplicate records.
- Audit events retain device ID/hash on operations. These are untrusted client hints, **not credentials, authorization decisions, or proof of compromise**. Missing/invalid hints show as unidentified. Clients can omit or forge them.
- Clearing storage, private browsing or changing browsers can produce another device record. Different devices may share a hash; a known device may change its hash. No cross-browser physical-device deduplication is claimed.
- User Management → Devices shows paginated history and links to that user's device-specific audit events. Only superusers can inspect device history. Admins cannot inspect even their own device list. Device IDs, fingerprints and new-device flags are redacted from admin audit responses, and device-specific audit filters are denied. Frontend device controls are hidden for admins. Device records are not backfilled from old IP/UA logs.
- A freshly loaded audit first page polls every 15 seconds. This is an in-app audit indicator, not an out-of-band alert or automatic account lock. Existing password change invalidates old REST/WS tokens.

## Audit

Records login success/failure, password changes, registration/user creation, permissions before/after, account deletion, room creation/settings/pin/end/delete, share creation/accept/revoke, guest join, note CRUD, playback compression, announcement creation. Passwords, tokens, source content, note text, announcement content, email and raw request bodies are excluded.

Mutation and event are transactional. Failure to store the audit event rolls back the operation. Private-room events are filtered by room visibility, including admin lists of events.

API supports page/pageSize (max 100), exact actor username, action, device ID, inclusive UTC start/end boundaries. UI accepts local date/time, labels the browser timezone, and sends ISO timestamps. Sort is `createdAt DESC, id DESC`; subsequent pages reuse a maximum-ID boundary so newly generated events do not shift the result set. Refresh resets the boundary. Count and page query use one repeatable-read transaction.

Indexes: timestamp + ID; username + timestamp + ID; action + timestamp + ID; device + timestamp + ID (partial); user-device latest-login index. Existing room/member indexes support the shared visibility predicate; no low-selectivity standalone private boolean index.

## Verification

Disposable PostgreSQL harness only; developer and production DBs are untouched. Suites:

```sh
bash scripts/test-runner-local.sh tests/private-rooms.mjs
bash scripts/test-runner-local.sh tests/audit-devices.mjs
```

These cover REST/WS role matrices, persistent shares and revocation, device attribution/concurrent login, safe metadata, audit rollback, timezones/tied timestamps/page boundaries and Chromium/Firefox/WebKit desktop/mobile at 3x DPI. Build: `cd frontend && bun run build`; Rust unit tests via harness.

Deployment caution: once private rooms exist, rolling the API back to a version without privacy enforcement would expose them under the older rules. Keep a privacy-aware API during rollback; extra schema columns alone do not protect access.

Final verification passed on 2026-09-17:

- 17 Rust unit tests and offline server build.
- Frontend TypeScript + production build (existing large-chunk warnings remain).
- `private-rooms.mjs`: full role/flag REST/WS matrix and all three browser engines, EN/ZH desktop/mobile 3x DPI.
- `audit-devices.mjs`: registration and login devices, concurrent/repeated/failed logins, permissions/password/share/room/note/account audit, secret exclusion, private-room isolation, transaction rollback, time and page filters; all three browser engines; user-device dialog and event links.
- Existing `share-links.mjs` and `admin-pagination.mjs` regressions passed, including all three browser engines.
- `git diff --check` clean.

Local logs: `/tmp/sharecode-final-{private-rooms,audit-devices,share-links,admin-pagination}.log` and `/tmp/sharecode-audit-build.log`. UI screenshots: `/tmp/sharecode-audit-*-{desktop-light,mobile-dark}.png`, `/tmp/sharecode-devices-{desktop,mobile}.png`.

Superuser-only follow-up verified: admin requests for self/other device histories return 404 regardless of global room flags; device-filter audit requests are denied; admin audit payloads redact device ID/hash/new-device status. Chromium, Firefox and WebKit confirm admin device buttons, fingerprint details and new-device labels are absent, while superuser controls work. Production frontend build and all 17 Rust tests passed. Logs: `/tmp/sharecode-superuser-devices-{tests,build}.log`. These checks preceded the deployment recorded above.
