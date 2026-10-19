-- When the account last renamed itself: once a week at most.
ALTER TABLE "User" ADD COLUMN "usernameChangedAt" TIMESTAMPTZ;
