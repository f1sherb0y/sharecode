-- Work table links: a tech opens their table through a link, without signing in.
-- A table made for someone without an account is a placeholder tech ("linkOnly")
-- that nobody can sign in as; it can later be merged into their real account.
ALTER TABLE "User" ADD COLUMN "linkOnly" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "tableToken" TEXT;
CREATE UNIQUE INDEX "User_tableToken_key" ON "User" ("tableToken") WHERE "tableToken" IS NOT NULL;
