ALTER TABLE "Room"
    ADD COLUMN IF NOT EXISTS "isPinned" BOOLEAN NOT NULL DEFAULT false;

-- Supports room list ordering: pinned rooms first, then newest rooms.
CREATE INDEX IF NOT EXISTS "Room_isDeleted_isPinned_createdAt_id_idx"
    ON "Room" ("isDeleted", "isPinned" DESC, "createdAt" DESC, id DESC);

-- Supports participant/owner room list filters with pin-priority ordering.
CREATE INDEX IF NOT EXISTS "Room_ownerId_isDeleted_isEnded_isPinned_createdAt_id_idx"
    ON "Room" ("ownerId", "isDeleted", "isEnded", "isPinned" DESC, "createdAt" DESC, id DESC);
