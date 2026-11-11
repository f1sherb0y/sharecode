package server

import "context"

// The role alone decides room access. These rules are enforced identically
// on the REST and WebSocket paths, together with room_is_visible() in SQL
// (see the roles migration): do not duplicate this logic elsewhere; call
// these helpers.
const (
	// roleAdmin (管理员): everything, including deleting rooms and creating
	// private rooms.
	roleAdmin = "admin"
	// roleAgent (中介): sees, edits, shares, pins and ends every standard room.
	roleAgent = "agent"
	// roleTech (技术): own rooms, live pinned rooms (read-only) and rooms
	// joined by share link.
	roleTech = "tech"
)

var validRoles = []string{roleAdmin, roleAgent, roleTech}

func isAdmin(role string) bool { return role == roleAdmin }

// isStaff: agents and admins can read and write every room they can see.
func isStaff(role string) bool { return role == roleAdmin || role == roleAgent }

func hasGlobalRead(user *AuthUser) bool { return isStaff(user.Role) }

// SQL lists use r (room), o (owner), and bind viewer ID/role/global-read
// first.
const roomVisibilitySQL = `room_is_visible(
    $1, $2, $3, r."ownerId", o.role, r."isPrivate", r."isPinned", r."isEnded", r."isDeleted",
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1),
    EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay")
)`

const roomPlaybackSQL = `(r."ownerId" = $1 OR $3
    OR (r."isPrivate" AND room_role_rank($2) > room_role_rank(o.role))
    OR (NOT r."isPrivate" AND EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = $1 AND p."canReplay")))`

// RoomAccess is what a user may do with a room.
type RoomAccess struct {
	OwnerID            string `db:"owner_id"`
	IsEnded            bool   `db:"is_ended"`
	CanView            bool   `db:"can_view"`
	CanViewPlayback    bool   `db:"can_view_playback"`
	CanEdit            bool   `db:"-"`
	ParticipantCanEdit *bool  `db:"participant_can_edit"`
}

// requireRoomAccess answers 404 for a room the user cannot see.
func requireRoomAccess(ctx context.Context, db DBTX, user *AuthUser, roomID string) (*RoomAccess, error) {
	access, err := queryOptional[RoomAccess](ctx, db, `SELECT r."ownerId" as owner_id, r."isEnded" as is_ended,
        `+roomVisibilitySQL+` as can_view,
        `+roomPlaybackSQL+` as can_view_playback,
        p."canEdit" as participant_can_edit
        FROM "Room" r JOIN "User" o ON o.id = r."ownerId"
        LEFT JOIN "RoomParticipant" p ON p."roomId" = r.id AND p."userId" = $1
        WHERE r.id = $4`, user.ID, user.Role, hasGlobalRead(user), roomID)
	if err != nil {
		return nil, dbError(err, "Failed to check room access")
	}
	if access == nil || !access.CanView {
		return nil, notFound("Room not found")
	}
	access.CanEdit = canEditRoomContent(access.IsEnded, access.OwnerID == user.ID, isStaff(user.Role), access.ParticipantCanEdit)
	return access, nil
}

// requireContentAccess: a result without error authorizes reading content;
// its value authorizes writing.
func requireContentAccess(ctx context.Context, db DBTX, actor *AuthActor, roomID string) (bool, error) {
	if actor.User != nil {
		access, err := requireRoomAccess(ctx, db, actor.User, roomID)
		if err != nil {
			return false, err
		}
		return access.CanEdit, nil
	}
	guest := actor.Guest
	if guest.RoomID != roomID {
		return false, notFound("Room not found")
	}
	canEdit, err := scalarOptional[bool](ctx, db, `SELECT g."canEdit" AND r."allowEdit" AND l."canEdit"
        FROM "GuestSession" g JOIN "Room" r ON r.id = g."roomId"
        JOIN "RoomShareLink" l ON l.id = g."shareLinkId" AND l."roomId" = r.id
        WHERE g.id = $1 AND g."shareLinkId" = $2 AND g.token = $3 AND r.id = $4
          AND NOT r."isDeleted" AND NOT r."isEnded"`, guest.GuestID, guest.ShareLinkID, guest.SessionToken, roomID)
	if err != nil {
		return false, dbError(err, "Failed to check guest room access")
	}
	if canEdit == nil {
		return false, notFound("Room not found")
	}
	return *canEdit, nil
}

func canEditRoom(user *AuthUser, room *RoomWithOwnerRow, participant *RoomParticipantWithUserRow) bool {
	var participantCanEdit *bool
	if participant != nil {
		participantCanEdit = &participant.CanEdit
	}
	return canEditRoomContent(room.IsEnded, room.OwnerID == user.ID, isStaff(user.Role), participantCanEdit)
}

// canEditRoomContent: document editing and note mutations must use exactly
// the same write rule. A link membership's canEdit is the permission of the
// link last joined through.
func canEditRoomContent(isEnded, isOwner, staff bool, participantCanEdit *bool) bool {
	return !isEnded && (isOwner || staff || (participantCanEdit != nil && *participantCanEdit))
}

// canManageRoom: share links and the room name belong to the owner and
// staff; members and share guests who joined through a link edit content
// and, when that link lets them edit, the language.
func canManageRoom(user *AuthUser, roomOwnerID string) bool {
	return user.ID == roomOwnerID || isStaff(user.Role)
}

func canEndRoom(user *AuthUser, roomOwnerID string) bool { return canManageRoom(user, roomOwnerID) }

// canDeleteRoom: only admins delete rooms, including their own.
func canDeleteRoom(user *AuthUser) bool { return isAdmin(user.Role) }
