-- Work tables: one per tech. A session no longer needs a customer, a tech can
-- mark time they are busy (a block: theirs alone, no customer, no room) and keep
-- a note pinned above their table for whoever plans their sessions.
ALTER TABLE "Appointment" ALTER COLUMN "customerId" DROP NOT NULL;
ALTER TABLE "Appointment" ADD COLUMN "isBlock" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_block_check"
    CHECK (NOT "isBlock" OR ("techId" IS NOT NULL AND "customerId" IS NULL AND "roomId" IS NULL));

ALTER TABLE "User" ADD COLUMN "scheduleNote" TEXT;
