# Compact UI deployment — 2026-09-16

- Site: https://collabcode.cc
- SSH host: `dmit-us`
- Release: `20260916-ui-124748`
- Frontend image: `sharecode-frontend:20260916-ui-124748`
- Image ID: `sha256:a06dafcfe94a45ab77f863f1b9cecd91334f341c79ab8e456b8fb0a9be304c0e`
- Source: tested local working tree, including uncommitted changes; exact source hashes are in the remote release manifest.
- Remote release directory: `/root/sharecode-releases/20260916-ui-124748`

Published the compact UI, consistent controls and pagination, localization improvements, Monaco find-widget fix, and fully clickable room rows with 50 rooms per page by default.

The backend source and migrations matched production. Only the frontend Compose service was recreated, with `--no-deps --no-build`. Production environment and server-specific configuration were preserved. The 101 frontend source files in the release manifest were copied into the production checkout and their hashes verified.

## Validation

- Frontend production build, i18n checks, and UI tests passed before release.
- Public HTML exactly matched the candidate; referenced entry assets returned successfully.
- Unauthenticated `/api/rooms` continued to return HTTP 401.
- Production English and Chinese login pages passed browser smoke checks in Chromium, Firefox, and WebKit, including desktop and phone viewport/DPI settings; no page errors or failed assets.
- All pre-existing containers other than the frontend retained their IDs and stayed running.
- Production smoke checks did not create accounts or alter room data. Authenticated room navigation was checked against the local backend before deployment.

## Rollback

```bash
ssh dmit-us 'bash /root/sharecode-releases/20260916-ui-124748/rollback.sh'
```

This switches only the frontend back to `sharecode-frontend:20260916-security-093025`. The script refuses to run if the frontend image has changed since this release. The previous Compose file, image ID, container inventory, and frontend source archive remain under the release directory's `backup/`. Restore the old source archive before rebuilding an old version; image rollback does not change checkout source.

The release directory also contains `manifest.json`, `build.log`, `browser-smoke.json`, and `deployed.json`.
