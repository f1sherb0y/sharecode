-- Migration: Convert all TIMESTAMP columns to TIMESTAMPTZ
--
-- Problem: TIMESTAMP (without timezone) columns store naive datetimes.
-- NOW() stores server-local time, but Rust code sometimes stored UTC
-- via Utc::now().naive_utc(). When reading, all values were treated
-- as UTC, causing an offset equal to the server's timezone.
--
-- Fix: Switch to TIMESTAMPTZ so PostgreSQL stores everything as UTC
-- internally and conversions are handled automatically.
--
-- Before altering, correct columns that were written as UTC from Rust
-- (endedAt, scheduledTime, lastSeen, lastActive) so that the implicit
-- "assume session timezone" conversion doesn't double-shift them.

-- Step 1: Fix columns that were stored as UTC via Rust code.
-- "val AT TIME ZONE 'UTC'" reinterprets a TIMESTAMP as UTC → TIMESTAMPTZ,
-- then "AT TIME ZONE current_setting('TimeZone')" converts back to a
-- naive TIMESTAMP in server-local time, so the subsequent ALTER is correct.

UPDATE "Room"
SET "endedAt" = ("endedAt" AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone')
WHERE "endedAt" IS NOT NULL;

UPDATE "Room"
SET "scheduledTime" = ("scheduledTime" AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone')
WHERE "scheduledTime" IS NOT NULL;

UPDATE "User"
SET "lastSeen" = ("lastSeen" AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone');

UPDATE "GuestSession"
SET "lastActive" = ("lastActive" AT TIME ZONE 'UTC') AT TIME ZONE current_setting('TimeZone');

-- Step 2: ALTER all TIMESTAMP columns to TIMESTAMPTZ.
-- PostgreSQL interprets existing values using the session timezone,
-- which is now correct for all columns after Step 1.

-- User
ALTER TABLE "User" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "User" ALTER COLUMN "lastSeen" TYPE TIMESTAMPTZ USING "lastSeen" AT TIME ZONE current_setting('TimeZone');

-- Room
ALTER TABLE "Room" ALTER COLUMN "scheduledTime" TYPE TIMESTAMPTZ USING "scheduledTime" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "Room" ALTER COLUMN "endedAt" TYPE TIMESTAMPTZ USING "endedAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "Room" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "Room" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE current_setting('TimeZone');

-- RoomParticipant
ALTER TABLE "RoomParticipant" ALTER COLUMN "joinedAt" TYPE TIMESTAMPTZ USING "joinedAt" AT TIME ZONE current_setting('TimeZone');

-- RoomShareLink
ALTER TABLE "RoomShareLink" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');

-- GuestSession
ALTER TABLE "GuestSession" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "GuestSession" ALTER COLUMN "lastActive" TYPE TIMESTAMPTZ USING "lastActive" AT TIME ZONE current_setting('TimeZone');

-- Document
ALTER TABLE "Document" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "Document" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE current_setting('TimeZone');

-- DocumentUpdate
ALTER TABLE "DocumentUpdate" ALTER COLUMN timestamp TYPE TIMESTAMPTZ USING timestamp AT TIME ZONE current_setting('TimeZone');

-- RoomNote
ALTER TABLE "RoomNote" ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE current_setting('TimeZone');
ALTER TABLE "RoomNote" ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE current_setting('TimeZone');
