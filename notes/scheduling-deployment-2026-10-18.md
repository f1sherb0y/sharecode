# Roles and scheduling deployment — 2026-10-18

Release `20261018-scheduling-093224` (commit `9427db0`, `roles-redesign` + `scheduling`
fast-forwarded into local `master`), server and frontend, deployed with user
authorization to `dmit-us` at 09:46 UTC. PostgreSQL, Piston and the container Caddy
were not changed (same container IDs before and after).

## What changed

- Roles: superuser → 管理员 admin, admin → 中介 agent, user → 技术 tech; the role alone
  decides access. Registration is invite-only (codes from admins and agents), and
  `ALLOW_REGISTRATION` no longer has any effect.
- 排班: customers, sessions, session rooms and schedule notices.
- Migrations `202610180001`–`202610180004` (17 → 21). They ran in 141 ms at server start.
- After the migration, `promote.sql` made the agreed staff agents: manager2 and
  manager3 (already agents by the mapping), plus Aurora, HJQ and baichao123 (from tech).
  Each change is in the audit log as `user.permissions_changed` with username `release`.
  The user named "baichao"; the only active account is `baichao123`, and two deleted
  `baichao` accounts were left alone.
- Result: admin 1 (admin), agent 5, tech 15 active accounts.

## Backups

- There were no ShareCode backups before this release. `/root/sharecode-backups/backup.sh`
  now runs daily at 08:20 UTC from root's crontab (flock, `pg_restore --list` check,
  14 days of `daily-*.dump`; log in `backup.log`).
- Pre-upgrade dumps: `/root/sharecode-backups/sharecode-20261018T093104Z-pre-scheduling.dump`
  (also copied off the host, same SHA-256) and the final pre-switch dump
  `backup/pre-deploy.dump` in the release directory (also in `/root/sharecode-backups`).

## Validation

- `just predeploy` on `9427db0`: 15/15 checks passed (`predeploy-logs/`).
- `stage.py` ran the built server image against a restored copy of production, twice
  (the second run after baichao123 was added). It checked:
  - 21/21 migrations, and every one of the 33 accounts mapped as above;
  - the promotion gives exactly the five agents and is idempotent;
  - room visibility (admin 1359, agent 1354, tech 185, agent matching the SQL rule);
  - replay of an existing ended room for a tech and an agent;
  - admin-only admin API, `allowRegistration: false`, and invite registration
    creating a tech;
  - a full scheduling round trip: customer, session, only-mine, tech's view,
    room "Acme Backend" opened by the tech, and the assignment notice.
- `deploy.py` verified the final dump's catalog, switched server and frontend in
  11.4 s, confirmed 21/21 migrations and the five agents, and found the other
  services unchanged.
- `verify-assets.py` passed on collabcode.cc, www.collabcode.cc, kode666.com,
  www.kode666.com and 64.186.229.171: HTML and 22 assets match the image, the
  scheduling/roles bundle is present, no `superuser` remains, registration is
  invite-only, API and runner are healthy.
- `just postdeploy` passed in Chromium, Firefox and WebKit on collabcode.cc,
  kode666.com and the IP. No errors or warnings in the server log after the switch.

## Rollback

The migrations are not reversible, so rollback restores the database:
`ssh dmit-us 'python3 /root/sharecode-releases/20261018-scheduling-093224/rollback.py'`.

- It restores `backup/pre-deploy.dump` into a new database and checks for 17
  migrations. Then it stops the server, swaps the databases (the replaced one is kept
  as `sharecode_failed_<time>`) and brings back `sharecode-server:20260929-multi-origin-180227`,
  `sharecode-frontend:20261006-guest-follow-094314` and the source files.
- Anything created after 09:46 UTC (sessions, customers, rooms, edits) exists only in
  the kept database.
- It refuses to run once a newer release has been selected.
