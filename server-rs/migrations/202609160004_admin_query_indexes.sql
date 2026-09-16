-- Small, low-write tables only. Room list and document history already have
-- suitable indexes; do not add a second index for every optional filter.
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS "User_active_createdAt_id_idx"
    ON "User" ("createdAt" DESC, id DESC) WHERE "isDeleted" = false;
-- The audit API filters username, not actorId, and paginates by id.
CREATE INDEX IF NOT EXISTS "AuditEvent_username_id_idx"
    ON "AuditEvent" (username, id DESC);
