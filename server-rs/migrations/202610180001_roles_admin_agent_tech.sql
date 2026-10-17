-- The role alone decides room access: admin (管理员), agent (中介) and
-- tech (技术). Customers are share-link guests and have no account.
-- Existing accounts map superuser -> admin, admin -> agent, user -> tech.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "User" DROP CONSTRAINT "User_role_check";
UPDATE "User" SET role = CASE role
    WHEN 'superuser' THEN 'admin'
    WHEN 'admin' THEN 'agent'
    ELSE 'tech'
END;
ALTER TABLE "User"
    ALTER COLUMN role SET DEFAULT 'tech',
    ADD CONSTRAINT "User_role_check" CHECK (role IN ('admin', 'agent', 'tech')),
    DROP COLUMN "canReadAllRooms",
    DROP COLUMN "canWriteAllRooms",
    DROP COLUMN "canDeleteAllRooms";

CREATE OR REPLACE FUNCTION room_role_rank(role_name TEXT) RETURNS INTEGER
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE role_name WHEN 'admin' THEN 2 WHEN 'agent' THEN 1 ELSE 0 END
$$;

-- Agents and admins (global_read) see every standard room. Techs see their own
-- rooms, live rooms they joined or that are pinned (read-only unless their
-- membership allows editing), and rooms they joined through a share link,
-- which also stay available for replay once ended. Private rooms remain
-- hidden from everyone except members and higher roles than the owner.
DROP FUNCTION room_is_visible(TEXT, TEXT, BOOLEAN, TEXT, TEXT, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN, BOOLEAN);
CREATE FUNCTION room_is_visible(
    viewer_id TEXT, viewer_role TEXT, global_read BOOLEAN,
    owner_id TEXT, owner_role TEXT, is_private BOOLEAN, is_pinned BOOLEAN,
    is_ended BOOLEAN, is_deleted BOOLEAN, is_member BOOLEAN, shared_replay BOOLEAN
) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT is_deleted AND (
        viewer_id = owner_id
        OR CASE WHEN is_private
            THEN room_role_rank(viewer_role) > room_role_rank(owner_role)
                OR (is_member AND (global_read OR NOT is_ended))
            ELSE global_read OR shared_replay OR (NOT is_ended AND (is_member OR is_pinned))
        END
    )
$$;

-- Joining a standard room through a share link now always keeps replay and
-- archive access after it ends, not only for invitations from higher roles.
UPDATE "RoomParticipant" p SET "canReplay" = true
FROM "Room" r
WHERE p."roomId" = r.id AND p."shareLinkId" IS NOT NULL AND NOT p."canReplay"
  AND NOT r."isPrivate" AND p."userId" <> r."ownerId";
