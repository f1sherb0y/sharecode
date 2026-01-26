# ShareCode WebSocket Protocol (Hocuspocus Provider v3.4.1)

This document defines the wire protocol required for a Rust backend to be a
drop-in replacement for the current Bun/Hocuspocus WebSocket server.

This protocol is based on the client library shipped in this repo:
`@hocuspocus/provider` v3.4.1 (see `frontend/node_modules/@hocuspocus/provider`).

Normative keywords: MUST, SHOULD, MAY, MUST NOT.

## 1. Transport

- Endpoint: `ws(s)://<host>/api/ws`
- WebSocket subprotocol: none.
- Frames: binary only (ArrayBuffer). Text frames MUST NOT be used.
- The server MUST accept multiple documents over a single WebSocket connection
  (multiplexing), routed by `documentName` in each message.

## 2. Framing and Encoding

Every message frame is:

```
varString(documentName) + varUint(messageType) + payload
```

- `varString` and `varUint` are encoded exactly as `lib0` does in the
  Hocuspocus provider (`writeVarString`, `writeVarUint`).
- `documentName` is the room ID (UUID string).

## 3. Message Types (Client-Side)

The client recognizes only the following `messageType` values:

| Type | Name            | Direction | Payload                                           |
|------|-----------------|-----------|---------------------------------------------------|
| 0    | Sync            | C<->S     | Yjs sync submessage (see Section 5).              |
| 1    | Awareness       | C<->S     | `varUint8Array` awareness update.                 |
| 2    | Auth            | C<->S     | Auth submessage (see Section 4).                  |
| 3    | QueryAwareness  | C<->S     | No payload.                                       |
| 5    | Stateless       | C<->S     | `varString` payload.                              |
| 7    | CLOSE           | C<->S     | `varString` reason.                               |
| 8    | SyncStatus      | S->C      | `varUint` 1 (applied) or 0 (rejected).            |

Compatibility rules:

- The client does NOT recognize `SyncReply (4)` or `BroadcastStateless (6)`.
  A Rust server MUST NOT send those message types.

## 4. Authentication Protocol

Auth messages wrap a submessage type defined by `@hocuspocus/common`:

```
AuthMessageType:
0 = Token
1 = PermissionDenied
2 = Authenticated
```

### 4.1 Client -> Server

On WebSocket open, the client sends:

```
Auth(Token, jwtString)
```

Where `jwtString` is the same JWT used for REST API authorization.

### 4.2 Server -> Client

The server MUST reply with exactly one of:

- `Auth(Authenticated, "readonly"|"read-write")`
- `Auth(PermissionDenied, reasonString)`

The client emits `onAuthenticated` or `onAuthenticationFailed` accordingly.

### 4.3 Token Refresh (Optional)

If the server needs the token again, it MAY send:

```
Auth(Token)
```

The client will respond with `Auth(Token, jwtString)`.

## 5. Sync Protocol (Yjs)

The Sync message payload follows `y-protocols/sync`:

```
SyncSubmessageType:
0 = SyncStep1
1 = SyncStep2
2 = Update
```

### 5.1 Typical Connection Sequence

1. C -> S: `Auth(Token, jwt)`
2. C -> S: `Sync(SyncStep1)`
3. C -> S: `Awareness` (if local awareness state exists)
4. S -> C: `Auth(Authenticated, scope)`
5. S -> C: `Sync(SyncStep1)` (request client state)
6. C -> S: `Sync(SyncStep2)`
7. S -> C: `Sync(SyncStep2)` (response to client step1)
8. S -> C: `SyncStatus(1)`

Ordering may vary, but the following rules MUST hold:

- The server MUST NOT apply or accept updates before successful Auth.
- When the server receives `SyncStep1`, it MUST send `SyncStep2`.
- The server SHOULD send its own `SyncStep1` to request the client state.
- For every `SyncStep2` and `Update` received from the client, the server MUST
  respond with `SyncStatus(1|0)` (applied or rejected).

### 5.2 Read-Only Behavior

If the connection is read-only:

- The server MUST NOT apply updates from the client.
- For `Update` submessages, respond `SyncStatus(0)`.
- For `SyncStep2`, the server SHOULD respond:
  - `SyncStatus(1)` if the update contains no new changes
    (equivalent to `snapshotContainsUpdate == true`).
  - `SyncStatus(0)` otherwise.

This mirrors Hocuspocus server behavior and avoids stale unsynced counters.

## 6. Awareness Protocol

Awareness uses `y-protocols/awareness` encoding.

- Client -> Server: `Awareness(updateBytes)`
- Server MUST apply the update to the document awareness state.
- Server MUST broadcast the same update to all connections for the document.
  Broadcasting MAY include the origin connection (Hocuspocus does).

Query behavior:

- On `QueryAwareness`, the receiver MUST respond with a full Awareness update
  containing all current awareness states.

## 7. Stateless Messages

Stateless payloads are UTF-8 strings:

```
Stateless(payloadString)
```

The payload is application-defined. For ShareCode, the required payload is:

```json
{
  "type": "room-status",
  "status": "ended",
  "endedAt": "2025-01-01T00:00:00.000Z"
}
```

The Rust server MUST broadcast this payload to all connections of the room
when a room is ended (REST: `POST /api/rooms/:roomId/end`).

## 8. Close Behavior

`CLOSE` frames are a polite close request:

```
CLOSE(reasonString)
```

The server MAY send CLOSE before closing the WebSocket.
The client MAY send CLOSE when detaching a provider.

## 9. ShareCode-Specific Semantics

These are not wire-level details but are required for drop-in compatibility:

- `documentName` MUST be the room ID (`room.id`).
- Auth rules MUST match the existing backend logic:
  - Users and guests are authenticated via JWT.
  - Ended rooms are read-only and restricted per role.
  - Guests obey share-link permissions and `room.allowEdit`.
- Updates MUST be persisted in the database exactly as Yjs updates, and the
  full document state MUST be stored as binary (Uint8Array).

## 10. Compatibility Notes

- Do not send `MessageType.SyncReply (4)` or `MessageType.BroadcastStateless (6)`.
  The client does not handle them.
- Do not send text frames.
- Use the exact lib0 encoding for varints and strings.
