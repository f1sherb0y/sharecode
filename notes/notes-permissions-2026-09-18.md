# Notes permissions and readable session exports

Notes use the room's content permissions, for both account holders and share
guests. Reading a room permits reading its notes; editing the document permits
creating, editing and deleting notes. REST and WebSocket account write decisions
share the same helper. Guest access checks the current session, share grant and
room state. Note operations hold the access read lock so a room closure or share
revocation cannot interleave with an authorized mutation. Mutations retain their
transactional audit events, including guest identities.

Existing room visibility and ended-room restrictions still apply. Ended rooms
are read-only, including for their owners. Notes remain accessible to readers
who retain replay access. Private, revoked and deleted rooms do not acquire new
read rights.

The export menu already followed replay read access, but fetching notes during
export used a stronger management requirement. Sharing the room read rule fixes
exports for managers and ordinary session readers without omitting the notes.
No change to the export format or added dependencies is needed.

Live Notes tabs now appear for every reader. Read-only controls are hidden and
mutation callbacks guard against writes after permission changes. Playback notes
are always read-only. Room details expose `canReadNotes` and `canWriteNotes`;
`canManageNotes` remains a compatibility alias for write access.

Login/register now share the larger branding component: 40px icon, 26px name.

## Persistent verification

`just test-notes` runs against disposable PostgreSQL and a real API. It covers
owner/member/global permissions, direct and shared grants, guests, private rooms,
cross-room note IDs, expired/mismatched credentials, downgraded grants, closed and
deleted rooms, revocation and audit records. Chromium, Firefox and WebKit verify
read-only and writable note controls, playback notes, and menu downloads by an
ordinary shared reader and a read-only manager. Each downloaded HTML is unpacked
to reconstruct the original code and verify that its notes are retained.

The suite is part of `just predeploy`. Also validated: 19 Rust tests, production
frontend build, private-room integration suite, standalone export replay in all
three browser engines, workspace layout checks and translation checks. An initial
Chromium settings-page load timed out during concurrent runs; its isolated rerun
passed. The i18n scan now documents the export's intentional bilingual selector
and fixed anonymous `userN` labels as source-specific exceptions.

These changes have not been deployed.
