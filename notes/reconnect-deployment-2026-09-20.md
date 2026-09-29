# Collaboration recovery deployment — 2026-09-20

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Frontend image: `sharecode-frontend:20260919-recovery-180225` (UTC release ID).
- Previous frontend: `sharecode-frontend:20260919-fullscreen-171340`.
- Source: working tree snapshot based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`, with SHA-256 manifests for 194 build files and 40 verification files. Hashes rechecked after the release gate. No commit or push.
- Exactly five build files differ from the prior release: frontend `bun.lock`, `package.json`, `patches/@hocuspocus%2Fprovider@3.4.4.patch`, `src/hooks/use-yjs-provider.ts`, and `src/lib/session-renewal.ts`.
- Fixes forced-reconnect sync-state mismatch, durability acknowledgement timeout/recovery, transient expired-session refresh recovery, and queued reconnect after revocation/destruction. Unacknowledged edits stay in the local outbox. See `reconnect-recovery-2026-09-20.md` for implementation and regression details.

`just predeploy` passed all 12 checks, including the new three-browser recovery suite (24 scenario results), session renewal, notes permissions/exports, all three workspace UI suites (13 tests each), fonts/fallback and standalone replay export. Gate logs: `/tmp/sharecode-predeploy.kVS59X`.

Built the frontend image from the manifested snapshot; nginx configuration passed. Only the frontend container was recreated. Server, PostgreSQL, Piston and Caddy IDs/images were unchanged. API health and runner health passed, all 17 migrations are successful, and anonymous room access is rejected.

Public HTML and 20 initial/lazy assets matched the deployed image byte for byte. Recovery code and prior fullscreen/scroll-lock/theme fixes are present. HTML retains its no-store cache policy.

`just postdeploy https://collabcode.cc` passed Chromium, Firefox and WebKit. Public checks used no account and changed no application data. Public smoke artifacts: `/tmp/sharecode-deployment-smoke-tA5X1P`.

Remote source/manifests, validation logs, build logs, prior source/Compose/container inventory, deployment and verification results, rollback script and public browser artifacts:
`/root/sharecode-releases/20260919-recovery-180225/`.

Guarded rollback refuses to overwrite a newer frontend release:

```sh
ssh dmit-us 'python3 /root/sharecode-releases/20260919-recovery-180225/rollback.py'
```
