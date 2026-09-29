# Compact workspace and selection feedback release

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Frontend image: `sharecode-frontend:20260917-selection-ui-081949`.
- Source: working tree snapshot based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`, with a SHA-256 manifest of 168 frontend files. This deployment does not create a Git commit or push.
- Includes compact room list and runner layout improvements, bottom mobile connection status, direct theme/blink controls, reliable Monaco and Markdown selection pulses, shared remote caret styling, disabled Monaco matching-text highlights, and the Markdown initialization client-ID fix.
- Only the frontend container changed. API, database, Piston and Caddy container IDs were checked to remain unchanged. No migration.

## Verification

- Production Docker build and nginx configuration check passed.
- Local real two-client tests passed on Chromium, Firefox and WebKit: selection pulses/repetition/expiry, empty selections, read-only mouse selection and signaling, offscreen reveal, mode switching, self-cursor exclusion and identity stability, Unicode, and mobile toolbar layout.
- JS/C++/TS/Python to Markdown round trips, delayed language responses and blank-state recovery passed on all three engines.
- Public HTML and all nine initial JS/CSS resources matched the deployed container byte for byte; index HTML uses no-cache/no-store.
- Public browser checks passed on all three engines at desktop and mobile 3x DPI: login, password autocomplete semantics, system light/dark defaults, loaded assets and no horizontal overflow.
- Public code-runner health reports all required languages available; unauthenticated room access returns 401.
- Production collaboration was not exercised with real users; collaboration tests used a disposable local database.

## Artifacts and rollback

`/root/sharecode-releases/20260917-selection-ui-081949/` contains source, manifest, build log, deployment record, previous source/Compose/container inventory, and guarded rollback scripts.

```sh
ssh dmit-us 'bash /root/sharecode-releases/20260917-selection-ui-081949/rollback.sh'
```

Rollback restores frontend image `sharecode-frontend:20260917-canvas-fixes-014130` and the previous frontend sources. It refuses if a newer frontend release has already been selected.
