/*
  Warnings:

  - You are about to drop the column `roomId` on the `Document` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Document" DROP CONSTRAINT "Document_roomId_fkey";

-- DropIndex
DROP INDEX "public"."Document_roomId_key";

-- DropIndex
DROP INDEX "public"."Room_documentId_key";

-- AlterTable
ALTER TABLE "Document" DROP COLUMN "roomId";
