# ShareCode API (original backend, deprecated)

This documents the original Node/Express backend routes (the Bun server has been removed from the repo).
Each endpoint includes: path, params (and structure), operation, and checks/constraints.

## Health & Config
- `GET /health`
  - Params: none
  - Operation: health check
  - Checks: none

- `GET /api/config/registration`
  - Params: none
  - Operation: returns `{ allowRegistration }`
  - Checks: none

## Auth
- `POST /api/auth/register`
  - Params (body): `{ username, password, email? }`
  - Operation: create user, return `{ user, token }`
  - Checks:
    - registration enabled
    - username/password required
    - username unique
    - email unique (if provided)

- `POST /api/auth/login`
  - Params (body): `{ username, password }`
  - Operation: login, return `{ user, token }`
  - Checks:
    - username/password required
    - user exists and not deleted
    - password valid

- `GET /api/auth/profile`
  - Params: auth header
  - Operation: return `{ user }` profile
  - Checks: auth required

## Users (room creation list)
- `GET /api/users`
  - Params: auth header
  - Operation: list users for room creation
  - Checks: auth required; `isDeleted = false`

## Rooms
- `POST /api/rooms`
  - Params (body):
    - `{ name, language?, scheduledTime?, duration?, allowedUsers?: [{ userId, canEdit? }] }`
  - Operation: create room, auto-add owner, add allowed users
  - Checks:
    - name required
    - language in supported list
    - auth required

- `GET /api/rooms`
  - Params: auth header
  - Operation: list rooms with membership metadata
  - Checks:
    - auth required
    - if no global read: only owner or participant rooms
    - participants only see non-ended rooms

- `GET /api/rooms/:roomId`
  - Params: `roomId`
  - Operation: room detail
  - Checks:
    - auth required
    - must be owner/participant/admin/global-read
    - ended rooms only owner/admin

- `GET /api/rooms/by-document/:documentId`
  - Params: `documentId`
  - Operation: alias of getRoom (documentId == roomId)
  - Checks: documentId required

- `PUT /api/rooms/:roomId`
  - Params (body): `{ name?, language? }`
  - Operation: update room
  - Checks:
    - auth required
    - must be owner/global-write/participant(canEdit)
    - language must be supported

- `DELETE /api/rooms/:roomId`
  - Params: `roomId`
  - Operation: delete room (hard delete)
  - Checks:
    - auth required
    - owner or global-delete

- `POST /api/rooms/:roomId/join`
  - Params: `roomId`
  - Operation: join room as participant
  - Checks:
    - auth required
    - room exists
    - room not ended
    - not already participant

- `POST /api/rooms/:roomId/leave`
  - Params: `roomId`
  - Operation: leave room
  - Checks:
    - auth required
    - owner cannot leave

- `POST /api/rooms/:roomId/end`
  - Params: `roomId`
  - Operation: end room and broadcast WS stateless message
  - Checks:
    - auth required
    - owner or global-delete

## Share links (room-scoped)
- `POST /api/rooms/:roomId/share-links`
  - Params (body): `{ canEdit? }`
  - Operation: create share link
  - Checks:
    - auth required
    - owner only
    - room exists and not ended
    - `canEdit` only if room.allowEdit

- `GET /api/rooms/:roomId/share-links`
  - Params: auth header
  - Operation: list share links
  - Checks: auth required; owner only

- `DELETE /api/rooms/:roomId/share-links/:shareLinkId`
  - Params: `roomId`, `shareLinkId`
  - Operation: delete share link
  - Checks: auth required; owner only; share link belongs to room

## Admin (auth + admin middleware)
- `POST /api/admin/users`
  - Params (body): `{ username, password, email?, role?, permissions? }`
  - Operation: create user
  - Checks:
    - auth/admin required
    - role valid
    - admins only create normal users
    - only superuser can create admin/superuser
    - username/email unique

- `GET /api/admin/users`
  - Params: auth header
  - Operation: list users
  - Checks: auth/admin required

- `PATCH /api/admin/users/:id`
  - Params (body): `{ role?, permissions? }` (permissions may be nested or top-level)
  - Operation: update role/permissions
  - Checks:
    - auth/admin required
    - role valid
    - only superuser can change roles
    - admins only manage normal users
    - cannot remove last superuser/admin

- `DELETE /api/admin/users/:id`
  - Params: `id`
  - Operation: soft-delete user
  - Checks:
    - auth/admin required
    - cannot delete self
    - admins cannot delete admins/superusers
    - cannot delete last superuser/admin

- `GET /api/admin/rooms`
  - Params: auth header
  - Operation: list rooms with owner + participants
  - Checks: auth/admin required

- `DELETE /api/admin/rooms/:id`
  - Params: `id`
  - Operation: soft-delete room
  - Checks: auth/admin required; must have delete-all or be superuser

## Playback
- `GET /api/rooms/:roomId/playback/updates`
  - Params: `roomId`
  - Operation: return compressed Yjs updates
  - Checks:
    - auth required
    - room exists
    - room must be ended
    - only owner or admin/superuser/global-read

## Guest share flow
- `GET /api/share/:token`
  - Params: `token`
  - Operation: get share + room info
  - Checks:
    - share link exists
    - room not deleted

- `POST /api/share/:token/join`
  - Params (body): `{ username, email? }`
  - Operation: create guest session + JWT
  - Checks:
    - username required
    - share link exists
    - room not ended

- `GET /api/share/session`
  - Params: `Authorization: Bearer <guestToken>`
  - Operation: restore guest session
  - Checks:
    - token provided and valid (guest)
    - session token matches
    - room not deleted

## Code execution (Piston)
- `POST /api/code/execute`
  - Params (body): `{ source_code, language_id, stdin? }`
  - Operation: execute code via Piston
  - Checks:
    - auth required
    - source_code and language_id required
    - language supported

- `GET /api/code/languages`
  - Params: none
  - Operation: list supported languages
  - Checks: none

- `GET /api/code/health`
  - Params: none
  - Operation: check Piston health
  - Checks: none

## WebSocket
- `GET /api/ws` (upgrade)
  - Params: WebSocket upgrade; Hocuspocus protocol
  - Operation: realtime collaboration
  - Checks: token-based auth inside WS protocol
