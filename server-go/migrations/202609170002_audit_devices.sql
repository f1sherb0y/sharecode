ALTER TABLE "AuditEvent"
    ADD COLUMN "deviceId" UUID,
    ADD COLUMN fingerprint TEXT,
    ADD COLUMN "newDevice" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "roomId" TEXT,
    ADD COLUMN details JSONB NOT NULL DEFAULT '{}';
CREATE TABLE "UserDevice" (
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "deviceId" UUID NOT NULL,
    fingerprint TEXT,
    "userAgent" TEXT NOT NULL,
    "lastIp" INET NOT NULL,
    "loginCount" BIGINT NOT NULL DEFAULT 1,
    "firstSeen" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY ("userId", "deviceId")
);
CREATE INDEX "UserDevice_user_lastSeen_idx" ON "UserDevice" ("userId", "lastSeen" DESC, "deviceId");
CREATE INDEX "AuditEvent_username_time_idx" ON "AuditEvent" (username, "createdAt" DESC, id DESC);
DROP INDEX "AuditEvent_action_idx";
CREATE INDEX "AuditEvent_action_time_idx" ON "AuditEvent" (action, "createdAt" DESC, id DESC);
CREATE INDEX "AuditEvent_device_time_idx" ON "AuditEvent" ("deviceId", "createdAt" DESC, id DESC) WHERE "deviceId" IS NOT NULL;
-- Associate historical sharing events while their targets still exist.
UPDATE "AuditEvent" SET "roomId" = "targetId" WHERE action IN ('share.accept', 'guest.join');
UPDATE "AuditEvent" a SET "roomId" = l."roomId" FROM "RoomShareLink" l
WHERE a.action = 'share.revoke' AND a."targetId" = l.id;
