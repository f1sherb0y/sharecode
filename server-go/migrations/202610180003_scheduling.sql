-- 排班 (scheduling): one customer list shared by all staff, and the sessions
-- (场次) agents and admins plan for techs. Customers never sign in; they join
-- a session's room through a share link.
CREATE TABLE "Customer" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact TEXT,
    notes TEXT,
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "isDeleted" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "Customer_name_idx" ON "Customer" (lower(name), id) WHERE NOT "isDeleted";

-- A session without a tech is still to be assigned. Status 'scheduled' reads
-- as completed once its room has ended; agents may also set it by hand.
CREATE TABLE "Appointment" (
    id TEXT PRIMARY KEY,
    "customerId" TEXT NOT NULL REFERENCES "Customer"(id) ON DELETE RESTRICT,
    "techId" TEXT REFERENCES "User"(id) ON DELETE RESTRICT,
    "agentId" TEXT REFERENCES "User"(id) ON DELETE RESTRICT,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "durationMinutes" INTEGER NOT NULL CHECK ("durationMinutes" BETWEEN 5 AND 1440),
    company TEXT,
    position TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
    "roomId" TEXT REFERENCES "Room"(id) ON DELETE SET NULL,
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX "Appointment_startsAt_idx" ON "Appointment" ("startsAt");
CREATE INDEX "Appointment_techId_startsAt_idx" ON "Appointment" ("techId", "startsAt");
CREATE INDEX "Appointment_customerId_startsAt_idx" ON "Appointment" ("customerId", "startsAt" DESC);
CREATE UNIQUE INDEX "Appointment_roomId_key" ON "Appointment" ("roomId") WHERE "roomId" IS NOT NULL;

-- Personal notices, such as a tech's new session. A NULL recipient is a
-- site-wide announcement, as before; kind and data let clients render them.
ALTER TABLE "Notification"
    ADD COLUMN "recipientId" TEXT REFERENCES "User"(id) ON DELETE CASCADE,
    ADD COLUMN kind TEXT,
    ADD COLUMN data JSONB;
CREATE INDEX "Notification_recipientId_createdAt_idx"
    ON "Notification" ("recipientId", "createdAt" DESC) WHERE "recipientId" IS NOT NULL;
