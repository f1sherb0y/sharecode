ALTER TABLE "DocumentUpdate" ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY;
ALTER TABLE "DocumentUpdate" ADD COLUMN "connectionId" TEXT;
CREATE UNIQUE INDEX "DocumentUpdate_seq_idx" ON "DocumentUpdate" (seq);
CREATE INDEX "DocumentUpdate_room_seq_idx" ON "DocumentUpdate" ("documentId", seq);
-- Existing snapshots have no trusted checkpoint: recover by replaying their history once.
ALTER TABLE "Document" ADD COLUMN "checkpointSeq" BIGINT NOT NULL DEFAULT 0;
