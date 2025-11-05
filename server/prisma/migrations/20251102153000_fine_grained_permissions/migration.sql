-- Add fine-grained room permission flags to users
ALTER TABLE "User"
    ADD COLUMN "canReadAllRooms" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "canWriteAllRooms" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "canDeleteAllRooms" BOOLEAN NOT NULL DEFAULT false;

-- Preserve historical observer/support access semantics before mapping roles
UPDATE "User"
SET "canReadAllRooms" = true
WHERE "role" IN ('observer', 'support');

UPDATE "User"
SET "canWriteAllRooms" = true
WHERE "role" IN ('support');

-- Superusers may already exist in some databases; ensure full access
UPDATE "User"
SET "canReadAllRooms" = true,
    "canWriteAllRooms" = true,
    "canDeleteAllRooms" = true
WHERE "role" = 'superuser';

-- Admins always require global read/write
UPDATE "User"
SET "canReadAllRooms" = true,
    "canWriteAllRooms" = true
WHERE "role" = 'admin';

-- Map deprecated roles onto the new role model
UPDATE "User"
SET "role" = 'admin'
WHERE "role" = 'support';

UPDATE "User"
SET "role" = 'user'
WHERE "role" = 'observer';

-- Clamp any unknown roles back to user
UPDATE "User"
SET "role" = 'user'
WHERE "role" NOT IN ('user', 'admin', 'superuser');
