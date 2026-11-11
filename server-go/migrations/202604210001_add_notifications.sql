CREATE TABLE IF NOT EXISTS "Notification" (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('normal', 'emergency')),
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "NotificationRead" (
    id TEXT PRIMARY KEY,
    "notificationId" TEXT NOT NULL REFERENCES "Notification"(id) ON DELETE CASCADE,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "readAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE ("notificationId", "userId")
);

CREATE INDEX IF NOT EXISTS "Notification_createdAt_severity_idx"
    ON "Notification" ("createdAt" DESC, severity);

CREATE INDEX IF NOT EXISTS "NotificationRead_userId_readAt_idx"
    ON "NotificationRead" ("userId", "readAt" DESC);
