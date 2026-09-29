-- Persistent browser credentials are random secrets; only their hashes are stored.
CREATE TABLE "BrowserSession" (
    id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    "secretHash" BYTEA NOT NULL UNIQUE,
    "tokenVersion" BIGINT NOT NULL,
    "deviceId" UUID,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "lastSeen" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "expiresAt" TIMESTAMPTZ NOT NULL,
    CHECK (octet_length("secretHash") = 32)
);
CREATE INDEX "BrowserSession_user_idx" ON "BrowserSession" ("userId");
CREATE INDEX "BrowserSession_expiry_idx" ON "BrowserSession" ("expiresAt");
