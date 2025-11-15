/*
  Warnings:

  - You are about to drop the column `documentId` on the `Room` table. All the data in the column will be lost.

*/

-- Step 1: Update Document table to use room.id as the name (which was previously documentId)
-- Match existing Document records with Room records
UPDATE "Document" d
SET name = r.id
FROM "Room" r
WHERE d.name = r."documentId";

-- Step 2: Update DocumentUpdate table to use room.id instead of documentId
UPDATE "DocumentUpdate" du
SET "documentId" = r.id
FROM "Room" r
WHERE du."documentId" = r."documentId";

-- Step 3: Drop the old index on documentId
DROP INDEX "Room_documentId_idx";

-- Step 4: Drop the documentId column from Room table
ALTER TABLE "Room" DROP COLUMN "documentId";
