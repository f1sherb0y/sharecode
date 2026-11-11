ALTER TABLE "Room" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;
-- An explicitly accepted invitation from a higher-role owner can retain
-- standard-room access after the session ends. Direct memberships stay as-is.
ALTER TABLE "RoomParticipant" ADD COLUMN "canReplay" BOOLEAN NOT NULL DEFAULT false;

-- Pure SQL functions are inlined by PostgreSQL. Lists, direct REST access and
-- WebSocket authentication share this predicate instead of drifting apart.
CREATE FUNCTION room_role_rank(role_name TEXT) RETURNS INTEGER
LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE role_name WHEN 'superuser' THEN 2 WHEN 'admin' THEN 1 ELSE 0 END
$$;

-- Existing, attributable invitations follow the same rule. Directly added
-- participants and memberships without a share association gain no access.
UPDATE "RoomParticipant" p SET "canReplay" = true
FROM "Room" r, "User" owner_user, "User" member_user
WHERE p."roomId" = r.id AND r."ownerId" = owner_user.id
  AND p."userId" = member_user.id AND p."shareLinkId" IS NOT NULL
  AND NOT r."isPrivate"
  AND room_role_rank(owner_user.role) > room_role_rank(member_user.role);

CREATE FUNCTION room_is_visible(
    viewer_id TEXT, viewer_role TEXT, global_read BOOLEAN,
    owner_id TEXT, owner_role TEXT, is_private BOOLEAN,
    is_ended BOOLEAN, is_deleted BOOLEAN, is_member BOOLEAN, shared_replay BOOLEAN
) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT NOT is_deleted
      AND (NOT is_private OR viewer_id = owner_id OR is_member
           OR room_role_rank(viewer_role) > room_role_rank(owner_role))
      AND (viewer_id = owner_id OR global_read
           OR (is_private AND room_role_rank(viewer_role) > room_role_rank(owner_role))
           OR (NOT is_private AND shared_replay)
           OR (is_member AND NOT is_ended))
$$;
