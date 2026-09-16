# Canvas, admin pagination and Markdown switch deployment

Deployed with user authorization to `dmit-us`, https://collabcode.cc.
Release: `20260916-canvas-admin-154141`.

Includes Admin user/room tabs with server pagination and filtering; two additive database indexes; collaborative Canvas, sampled synchronization, Follow and replay; compact themed controls; code-to-Markdown initialization race fix and synchronous Markdown serialization when switching back to code.

## Release verification

- Source archive hash-verified against a per-file manifest. Existing production source matched the prior release before staging. Only expected frontend changes, admin route changes and migration 202609160004 differed.
- PostgreSQL custom-format backup created and its archive catalog verified before switching. Previous Compose file, source archive and container inventory preserved.
- Frontend and API images built on the server from the staged source. Deployment uses immutable release tags and changes only those two Compose services.
- Public entry HTML matched the image; entry assets, Canvas/Markdown chunks and a locally hosted Canvas font loaded successfully.
- Authenticated read-only production checks confirmed users/rooms pagination and empty-result filtering. Both indexes and SQLx migration success verified. Runner health passed with all required runtimes available.
- PostgreSQL, Piston, gateway and unrelated containers retained their IDs and remained running.
- First attempt automatically rolled back because the asset check incorrectly expected separate Admin/playback chunks. These are bundled in the main entry. Corrected the assertion to check the actual lazy Canvas/Markdown chunks and redeployed successfully; no application build change was needed.
- Public login-page smoke checks passed in Chromium, Firefox and WebKit, in English on desktop and Chinese at a touch-sized 3x-DPI viewport; no page errors or failed script/style/font requests.
- Local checks before deployment included Markdown switching/recovery across Chromium, Firefox and WebKit, frontend build, admin/Canvas integration, synchronization/replay and UI/i18n regressions. Drawing feel and fidelity remain for the user's manual evaluation.

Remote artifacts: `/root/sharecode-releases/20260916-canvas-admin-154141/` contains manifest, exact source, build/deployment logs, database/source/Compose backups, deployment record and rollback script. Production checkout source synchronized and hash-verified.

Rollback:

```bash
ssh dmit-us 'bash /root/sharecode-releases/20260916-canvas-admin-154141/rollback.sh'
```

Restores frontend `20260916-runner-bar-134734` and API `20260916-runner-130949`; refuses if image references changed after this release. Additive indexes and all user data remain. Restoring the previous source archive is required before rebuilding the previous release. Previous UI does not expose the new Canvas feature; Canvas document data is retained.
