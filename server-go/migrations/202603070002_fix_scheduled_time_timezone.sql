-- Migration: Fix scheduledTime for rooms created before the timezone fix
--
-- Problem: Before the chrono-tz fix (deployed ~2026-03-07 01:30 Shanghai time),
-- parse_scheduled_time used local_to_utc which was a no-op on the UTC server.
-- So scheduledTime was stored as the user's Shanghai local time in a naive
-- TIMESTAMP column. The previous migration (202603070001) treated it as
-- UTC-stored and ALTERed to TIMESTAMPTZ, causing Shanghai wall-clock times
-- to be tagged as UTC — 8 hours off.
--
-- Fix: Reinterpret the stored UTC-tagged values as Asia/Shanghai times.

UPDATE "Room"
SET "scheduledTime" = ("scheduledTime" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai'
WHERE "scheduledTime" IS NOT NULL
  AND "createdAt" < '2026-03-06T17:30:00+00:00';
