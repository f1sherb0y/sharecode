# Persistent browser login — 2026-09-17

Local implementation only; deployment is paused.

## Standard mechanism

A server-managed, opaque session credential is stored in a persistent cookie.
The cookie has a 30-day Max-Age, HttpOnly, SameSite=Lax and Path=/; production
uses Secure and the __Host-sharecode-session name without a Domain attribute.
Only explicit HTTP loopback development uses the non-Secure sharecode-session
cookie. Configure APP_URL and FRONTEND_URL with the actual trusted origins.

BrowserSession stores only the SHA-256 hash of a cryptographically random
256-bit secret, plus the user, device hint, token version and expiry. Successful
refresh slides both the cookie and server expiry forward by 30 days. This is a
revocable server session, not a password saved in browser storage.

The existing bearer-token API and WebSocket protocol use 15-minute access JWTs.
They remain in sessionStorage, scoped to a tab; the persistent credential is
never exposed to frontend JavaScript. On startup, absent or expired user access
tokens are recovered via POST /api/auth/refresh with credentials included.
Renewal starts within two minutes of expiry and is checked during editing,
online/visibility changes and API requests. Transient failures retain local
state for retry. Valid pre-cookie JWTs can upgrade to a browser session; expired
legacy tokens alone cannot create one.

Each browser profile/device can log in independently. Logout revokes only its
current browser session, closes that session's sockets and notifies sibling
user tabs; guest tabs remain isolated. Password changes invalidate every old
session and issue a new one for the initiating browser. Deleted accounts cannot
refresh or use existing sessions. Cookie requests require the custom web-client
header and reject untrusted Origin values; CORS allows only configured origins
and the existing Tauri origins. Bearer/session identity checks prevent stale
tabs from silently adopting a different account's cookie.

Normal browser and operating-system restarts retain the cookie. Clearing site
data, private-browsing teardown, explicit logout, revocation or 30 days without
refresh require logging in again. Desktop Tauri cross-site cookie behavior is
not covered by the browser restart tests.

## Validation

- cargo check --manifest-path server-rs/Cargo.toml --offline
- cargo test --manifest-path server-rs/Cargo.toml --offline (19 unit tests)
- bash scripts/test-runner-local.sh tests/browser-sessions.mjs
- bash scripts/test-runner-local.sh tests/session-renewal.mjs
- frontend: bun run build

The browser-session suite restarts real Chromium, Firefox and WebKit processes
using disk-backed profiles. It checks restoration without a tab token, expired
JWT recovery, guest isolation, logout persistence, cookie attributes, hashed
storage, CSRF/CORS rejection, concurrent refresh, legacy upgrade, session expiry,
password revocation and per-device HTTP/WebSocket logout. The renewal suite
checks continued editing, socket/editor identity, transient failures and multiple
devices. Both suites use disposable PostgreSQL containers, not development data.

This supersedes the seven-day bearer-only renewal and tab-only login description
in font-loading-session-renewal-2026-09-17.md.

Results: all listed checks passed. Browser restarts passed for Chromium, Firefox
and WebKit. The existing Chromium workspace suite also passed after updating its
obsolete audit-pagination mock (the previously failing case was rerun separately).
The navbar brand is now a 28px icon with 18px text; desktop/phone screenshots and
the existing 1x–3x DPI layout checks passed. No commit or deployment was made.
