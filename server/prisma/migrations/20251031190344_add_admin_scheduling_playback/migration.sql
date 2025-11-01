-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "duration" INTEGER,
ADD COLUMN     "endedAt" TIMESTAMP(3),
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isEnded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scheduledTime" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "DocumentUpdate" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "update" BYTEA NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "DocumentUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentUpdate_documentId_timestamp_idx" ON "DocumentUpdate"("documentId", "timestamp");
