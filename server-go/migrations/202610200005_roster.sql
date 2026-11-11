-- The names on the work tables: the techs whose tables are listed and the 管理 who book.
-- Each name stands for an account, a placeholder ("linkOnly") when the person has none.
CREATE TABLE "RosterEntry" (
    kind TEXT NOT NULL CHECK (kind IN ('tech', 'manager')),
    "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, "userId")
);
CREATE UNIQUE INDEX "RosterEntry_name_key" ON "RosterEntry" (kind, lower(name));
