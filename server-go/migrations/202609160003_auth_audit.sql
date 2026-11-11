ALTER TABLE "User" ADD COLUMN "tokenVersion" BIGINT NOT NULL DEFAULT 0;
CREATE TABLE "AuditEvent" (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    action TEXT NOT NULL,
    "actorId" TEXT,
    username TEXT,
    "targetId" TEXT,
    success BOOLEAN NOT NULL,
    "clientIp" INET NOT NULL,
    "peerIp" INET NOT NULL,
    "ipSource" TEXT NOT NULL,
    "userAgent" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    reason TEXT
);
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent" ("createdAt" DESC, id DESC);
CREATE INDEX "AuditEvent_actor_idx" ON "AuditEvent" ("actorId", id DESC);
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent" (action, id DESC);
