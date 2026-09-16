# Canvas controls, password autofill and system theme

Released with user authorization to `dmit-us`, https://collabcode.cc.
Image: `sharecode-frontend:20260916-ui-autofill-161328` (UTC release timestamp).

- Compact Canvas menu rows, correctly sized More tools/Help icons, shortcuts in tooltips instead of overlapping digits, and unclipped mobile More tools popup. Touch targets remain 44px.
- Login, registration, password change and admin user creation use explicit field names and autocomplete semantics. Submission reads actual DOM values so password-manager fills without React change events work. Password-change forms include the current username; new passwords are marked separately from existing credentials.
- With no saved theme, initial rendering follows the system preference. Explicit manual preferences retain priority on reload. Inline bootstrap applies the theme before the app loads.

## Verification

Local production build and diff checks passed. Chromium, Firefox and WebKit checked Canvas menus/icons, mobile touch/3x DPI, autofilled form submissions, failed-login retry, registration, password update/admin creation and theme initialization/persistence.

Public release HTML matches the image; entry assets and Canvas stylesheet loaded; API authentication and runner health passed. Only the frontend container changed. Production checkout source was synchronized and hash-verified. No database migration or account/password change was required.

Public browser checks passed all six scenarios across Chromium, Firefox and WebKit: system light/dark defaults, saved manual preference after reload, login form/autocomplete semantics, desktop and touch-sized 3x-DPI layout, with no page errors or failed scripts/styles/fonts. No credentials were submitted to production.

The save/update-password prompt belongs to the browser. Browser-owned popup behavior still needs user confirmation in a normal Chrome profile with password saving enabled.

## Artifacts and rollback

`/root/sharecode-releases/20260916-ui-autofill-161328/` holds the source/hash manifest, build/deployment records, previous frontend source/Compose/container inventory and rollback script. Image rollback preserves all application data and API/runtime services:

```bash
ssh dmit-us 'bash /root/sharecode-releases/20260916-ui-autofill-161328/rollback.sh'
```

The rollback refuses if the deployed image reference has since changed. It restores frontend `20260916-canvas-admin-154141`; restore the source backup before rebuilding that old version.
