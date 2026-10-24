# CI release uploads and new logo — deployment 2026-10-25

Release `20261024-ci-logo-205954` (commit `eb8a068`), server and frontend, deployed with user authorization to
`dmit-us` at about 21:05 UTC on 2026-10-24. It replaces `20261024-client-releases-194224`
(`755ad32`). Migration 29 (`202610260001_ci_client_releases`: `ClientRelease.createdBy` nullable).

## What changed

- The release workflow (`.github/workflows/client-release.yml`, tag `client-v<version>`) opens a
  client release draft and uploads its files with a CI token; it cannot publish, edit or delete.
  `.env.production` holds the token's SHA-256 (`CLIENT_RELEASES_CI_TOKEN_SHA256`), passed to the
  server by `docker-compose.production.yml`; the token is a GitHub secret.
- New logo (two slashes, white and sunset, on a dark tile) on the site, favicons and both apps;
  the frontend also carries the desktop branding commits since `755ad32`.

## Validation

- predeploy and postdeploy skipped at the user's request.
- `stage.py` on a restored copy of production (52 accounts): migrations 29/29; the CI token opens
  and reopens a draft, is refused without a token or with an admin JWT, cannot list, publish or
  delete; audited as "CI workflow". Rollback rehearsal: `undo-migration.sql` with a CI draft in
  place, then the previous server started on the copy.
- `deploy.py`: verified dump (77 MB, also in `/root/sharecode-backups`); switched in 11.3 s;
  migrations 29/29; the CI route answers 401 without the token. `verify-assets.py` passed on
  collabcode.cc, www.collabcode.cc, kode666.com, www.kode666.com and https://64.186.229.171.
- First CI release: `client-v0.2.0`, run 40132736351, uploaded the draft 0.2.0 (Windows
  installer, universal DMG and `.app.tar.gz` for both macOS entries, all signed). Not published.

## Rollback

`ssh dmit-us 'python3 /root/sharecode-releases/20261024-ci-logo-205954/rollback.py'`

It stops the server, undoes migration 29 (CI drafts get the first admin as creator), restores the
compose file, `.env.production` and source files, and starts the previous images.
