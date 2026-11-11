-- Registration is invite-only: admins and agents issue single-use codes, and a
-- tech registers with one. Used invites stay as the record of who invited whom.
CREATE TABLE "RegistrationInvite" (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    note TEXT,
    "createdBy" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "usedAt" TIMESTAMPTZ,
    "usedBy" TEXT REFERENCES "User"(id) ON DELETE RESTRICT
);
CREATE INDEX "RegistrationInvite_createdBy_idx" ON "RegistrationInvite" ("createdBy", "createdAt" DESC);
