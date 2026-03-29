ALTER TABLE "RoomShareLink"
    ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS "consumedAt" TIMESTAMPTZ;

UPDATE "RoomShareLink" l
SET "expiresAt" = COALESCE(
    l."expiresAt",
    l."createdAt" + INTERVAL '6 hours'
);

UPDATE "RoomShareLink" l
SET "consumedAt" = guest.first_joined_at
FROM (
    SELECT "shareLinkId", MIN("createdAt") AS first_joined_at
    FROM "GuestSession"
    GROUP BY "shareLinkId"
) guest
WHERE guest."shareLinkId" = l.id
  AND l."consumedAt" IS NULL;

ALTER TABLE "RoomShareLink"
    ALTER COLUMN "expiresAt" SET NOT NULL,
    ALTER COLUMN "expiresAt" SET DEFAULT (NOW() + INTERVAL '6 hours');

CREATE INDEX IF NOT EXISTS "RoomShareLink_unused_expiresAt_idx"
    ON "RoomShareLink" ("expiresAt")
    WHERE "consumedAt" IS NULL;
