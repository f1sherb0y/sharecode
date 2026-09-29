# Fullscreen menu deployment — 2026-09-20

Deployed with user authorization to `dmit-us`, https://collabcode.cc.

- Frontend image: `sharecode-frontend:20260919-fullscreen-171340` (UTC release ID).
- Source: tested working tree snapshot based on `db2f65b8bf6bb49e4d7728e2b4e88ff94c9d538d`, with SHA-256 manifests for 193 build files and verification sources. Source hashes rechecked after predeploy. No commit or push.
- Five build files differ from the previous release: `frontend/bun.lock`, `frontend/package.json`, `frontend/patches/monaco-editor@0.55.1.patch`, `frontend/src/hooks/use-fullscreen.ts`, `frontend/src/pages/editor.tsx`.
- Editor fullscreen now targets the document element, including body-mounted menus, selects and dialogs. Leaving the editor exits the fullscreen session it started. Monaco's WebKit clipboard workaround now observes cancellation of the pending data promise even when fullscreen consumed the gesture and WebKit rejected the clipboard request.

`just predeploy` passed all 11 checks. Chromium, Firefox and WebKit each passed 13 workspace UI tests, including actual fullscreen code/Markdown interactions, themes, menu/select/dialog hit testing, repeated entry/exit, preserved editor/content and exit on navigation.

Initial gate `/tmp/sharecode-predeploy.iJei0z` stopped on an existing immediate focus assertion in the scrolled-room test. Radix restores focus via deferred unmount callback; the test now waits for actual trigger focus and retains the original assertion. Full gate rerun passed: `/tmp/sharecode-predeploy.OuJloY`. Both gate logs are retained with the release.

Built the frontend image from the manifested snapshot and checked nginx configuration. Only the frontend container was recreated; API, database, Piston and Caddy container IDs/images remained unchanged. All 17 existing migrations are successful; no migrations added.

Public HTML and 20 initial/lazy assets matched the deployed image byte for byte. Published editor asset includes the document fullscreen target. Previous scroll-lock/theme CSS fixes remain present. HTML cache policy, anonymous access rejection and runner health passed.

`just postdeploy https://collabcode.cc` passed Chromium, Firefox and WebKit on desktop/light and mobile/dark/3x DPI. Public smoke checks used no account and changed no application data. Local public artifacts: `/tmp/sharecode-deployment-smoke-wtRbjj`.

Remote release artifacts, source/manifests, gate logs, Docker build logs, previous Compose/source/container inventory, verification and browser screenshots:
`/root/sharecode-releases/20260919-fullscreen-171340/`.

Previous frontend: `sharecode-frontend:20260919-menu-scroll-164925`.
Guarded rollback refuses to overwrite a newer frontend release:

```sh
ssh dmit-us 'python3 /root/sharecode-releases/20260919-fullscreen-171340/rollback.py'
```
