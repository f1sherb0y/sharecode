-- Drafts the release workflow (CI) opens belong to no account: "createdBy" is NULL for them.
ALTER TABLE "ClientRelease" ALTER COLUMN "createdBy" DROP NOT NULL;
