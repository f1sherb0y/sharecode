-- Guided tours an account has finished or skipped: each is shown once per account,
-- on any device.
ALTER TABLE "User" ADD COLUMN "seenTours" TEXT[] NOT NULL DEFAULT '{}';
