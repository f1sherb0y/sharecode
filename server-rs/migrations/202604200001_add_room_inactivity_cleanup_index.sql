CREATE INDEX IF NOT EXISTS "Room_inactivity_cleanup_idx"
    ON "Room" ("isDeleted", "isEnded", "isPinned", "updatedAt");
