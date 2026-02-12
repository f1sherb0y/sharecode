ALTER TABLE "Room"
    ADD COLUMN IF NOT EXISTS company TEXT,
    ADD COLUMN IF NOT EXISTS position TEXT;

-- Supports pagination by newest creation time first.
CREATE INDEX IF NOT EXISTS "Room_isDeleted_createdAt_id_idx"
    ON "Room" ("isDeleted", "createdAt" DESC, id DESC);

-- Supports room list filters by owner + activeness.
CREATE INDEX IF NOT EXISTS "Room_ownerId_isDeleted_isEnded_createdAt_id_idx"
    ON "Room" ("ownerId", "isDeleted", "isEnded", "createdAt" DESC, id DESC);
