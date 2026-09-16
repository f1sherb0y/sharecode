# Room language permissions and runner repair

Deployed to `dmit-us`, https://collabcode.cc, release `20260916-runner-130949`.

## Changes

- Owners, admins and superusers can change room language. Admin language-only updates work independently of global document-write flags, without granting write access to room content or allowing unrelated settings changes.
- Added language selectors to admin room management, including rooms an admin cannot open for editing. Editor selectors now allow admins/superusers in other users' rooms.
- Language updates broadcast to connected editors and refresh on reconnect; initial room settings take precedence over old Yjs language metadata.
- Added C to room creation, language switching and Monaco configuration.
- Production Piston had no installed runtimes. Installed Python 3.12.0, Java 15.0.2, GCC 10.2.0 (C/C++), Node 20.11.1 and TypeScript 5.0.3 in its existing persistent package volume. No Piston container restart was needed.
- Code execution now accepts nullable exit codes and optional metrics, reports compile diagnostics and timeouts correctly, allows ten seconds for compilation, and limits upstream HTTP requests. Java uses Piston's default source-launcher filename.
- Runner health reports missing required runtimes with HTTP 503. Added the idempotent `scripts/setup-piston.cjs` installer, `just runner-up` and `just test-runner`.

## Validation

- Rust: 16 unit tests passed. Frontend production build and three i18n checks passed.
- Disposable local database + real production Piston sandbox: all six languages executed and read stdin; C/TypeScript compilation errors, Python runtime errors and timeout classification passed.
- Permission regression covered owners, superusers, admins with/without global read/write flags, denial for ordinary editing members, and denial of mixed unauthorized settings updates.
- Read-only clients received live language changes and the current language on reconnect. Browser editor tests covered admin, read-only admin and ordinary member selectors. Existing secondary-page and language UI tests passed.
- After deployment, all six languages ran through the public authenticated API and returned the expected stdin output. Compile-error and timeout probes also passed. Health, authentication and frontend entry assets passed.
- Only the frontend and API containers were replaced. PostgreSQL, Piston, gateway and unrelated containers retained their IDs and remained running. No production account or room data was created or changed by smoke checks.

## Release and rollback

Images: `sharecode-frontend:20260916-runner-130949` and `sharecode-server:20260916-runner-130949`.

Remote release directory: `/root/sharecode-releases/20260916-runner-130949`. Contains manifest hashes, exact source, previous source/Compose backups, build logs, integration log, and deployment verification record. Production source was synchronized and hash-verified.

```bash
ssh dmit-us 'bash /root/sharecode-releases/20260916-runner-130949/rollback.sh'
```

Rollback changes only the frontend/API image references and recreates those services without dependencies. Installed runtimes are retained. The script refuses if image references changed after this release. Restore the source backup before rebuilding the old application version.
