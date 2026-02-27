CREATE TABLE IF NOT EXISTS "User" (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    color TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin', 'superuser')),
    "canReadAllRooms" BOOLEAN NOT NULL DEFAULT false,
    "canWriteAllRooms" BOOLEAN NOT NULL DEFAULT false,
    "canDeleteAllRooms" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "lastSeen" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Room" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'javascript',
    company TEXT,
    position TEXT,
    "ownerId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "allowEdit" BOOLEAN NOT NULL DEFAULT true,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "scheduledTime" TIMESTAMP,
    duration INTEGER,
    "isEnded" BOOLEAN NOT NULL DEFAULT false,
    "endedAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "RoomParticipant" (
    id TEXT PRIMARY KEY,
    "roomId" TEXT NOT NULL REFERENCES "Room"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE ("roomId", "userId")
);

CREATE TABLE IF NOT EXISTS "RoomShareLink" (
    id TEXT PRIMARY KEY,
    "roomId" TEXT NOT NULL REFERENCES "Room"(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "GuestSession" (
    id TEXT PRIMARY KEY,
    "shareLinkId" TEXT NOT NULL REFERENCES "RoomShareLink"(id) ON DELETE CASCADE,
    "roomId" TEXT NOT NULL REFERENCES "Room"(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE,
    "displayName" TEXT NOT NULL,
    email TEXT,
    color TEXT NOT NULL,
    "canEdit" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "lastActive" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Document" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE REFERENCES "Room"(id) ON DELETE CASCADE,
    data BYTEA,
    "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "DocumentUpdate" (
    id TEXT PRIMARY KEY,
    "documentId" TEXT NOT NULL REFERENCES "Room"(id) ON DELETE CASCADE,
    update BYTEA NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
    "userId" TEXT
);

CREATE INDEX IF NOT EXISTS "Room_ownerId_idx"
    ON "Room" ("ownerId");

CREATE INDEX IF NOT EXISTS "Room_isDeleted_createdAt_id_idx"
    ON "Room" ("isDeleted", "createdAt" DESC, id DESC);

CREATE INDEX IF NOT EXISTS "Room_ownerId_isDeleted_isEnded_createdAt_id_idx"
    ON "Room" ("ownerId", "isDeleted", "isEnded", "createdAt" DESC, id DESC);

CREATE INDEX IF NOT EXISTS "Room_isDeleted_isPinned_createdAt_id_idx"
    ON "Room" ("isDeleted", "isPinned" DESC, "createdAt" DESC, id DESC);

CREATE INDEX IF NOT EXISTS "Room_ownerId_isDeleted_isEnded_isPinned_createdAt_id_idx"
    ON "Room" ("ownerId", "isDeleted", "isEnded", "isPinned" DESC, "createdAt" DESC, id DESC);

CREATE INDEX IF NOT EXISTS "RoomParticipant_roomId_idx"
    ON "RoomParticipant" ("roomId");

CREATE INDEX IF NOT EXISTS "RoomParticipant_userId_idx"
    ON "RoomParticipant" ("userId");

CREATE INDEX IF NOT EXISTS "RoomShareLink_roomId_idx"
    ON "RoomShareLink" ("roomId");

CREATE INDEX IF NOT EXISTS "RoomShareLink_createdBy_idx"
    ON "RoomShareLink" ("createdBy");

CREATE INDEX IF NOT EXISTS "GuestSession_shareLinkId_idx"
    ON "GuestSession" ("shareLinkId");

CREATE INDEX IF NOT EXISTS "GuestSession_roomId_idx"
    ON "GuestSession" ("roomId");

CREATE INDEX IF NOT EXISTS "DocumentUpdate_documentId_timestamp_idx"
    ON "DocumentUpdate" ("documentId", timestamp);
