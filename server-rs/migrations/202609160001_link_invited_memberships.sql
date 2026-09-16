-- Only memberships created by accepting an invitation carry this association.
-- Explicit membership, ownership and global permissions remain independent.
ALTER TABLE "RoomParticipant"
    ADD COLUMN "shareLinkId" TEXT REFERENCES "RoomShareLink"(id) ON DELETE CASCADE;
CREATE INDEX "RoomParticipant_shareLinkId_idx" ON "RoomParticipant" ("shareLinkId");
