package server

import "time"

// The rows server-rs reads (db/models.rs). The db tags are the column
// aliases its queries select.

type UserRow struct {
	TokenVersion int64     `db:"token_version"`
	ID           string    `db:"id"`
	Email        *string   `db:"email"`
	Username     string    `db:"username"`
	Password     string    `db:"password"`
	Color        string    `db:"color"`
	Role         string    `db:"role"`
	IsDeleted    bool      `db:"is_deleted"`
	CreatedAt    time.Time `db:"created_at"`
	LastSeen     time.Time `db:"last_seen"`
}

type UserPublicRow struct {
	ID        string    `db:"id"`
	Email     *string   `db:"email"`
	Username  string    `db:"username"`
	Color     string    `db:"color"`
	Role      string    `db:"role"`
	CreatedAt time.Time `db:"created_at"`
	LastSeen  time.Time `db:"last_seen"`
}

type UserSimpleRow struct {
	ID       string `db:"id"`
	Username string `db:"username"`
	Color    string `db:"color"`
	Role     string `db:"role"`
}

type RoomWithOwnerRow struct {
	ID              string     `db:"id"`
	Name            string     `db:"name"`
	Language        string     `db:"language"`
	Company         *string    `db:"company"`
	Position        *string    `db:"position"`
	OwnerID         string     `db:"owner_id"`
	IsPrivate       bool       `db:"is_private"`
	CanViewPlayback bool       `db:"can_view_playback"`
	AllowEdit       bool       `db:"allow_edit"`
	IsPinned        bool       `db:"is_pinned"`
	IsDeleted       bool       `db:"is_deleted"`
	ScheduledTime   *time.Time `db:"scheduled_time"`
	Duration        *int32     `db:"duration"`
	IsEnded         bool       `db:"is_ended"`
	EndedAt         *time.Time `db:"ended_at"`
	CreatedAt       time.Time  `db:"created_at"`
	UpdatedAt       time.Time  `db:"updated_at"`
	OwnerUsername   string     `db:"owner_username"`
	OwnerColor      string     `db:"owner_color"`
}

type RoomAdminRow struct {
	ID              string     `db:"id"`
	Name            string     `db:"name"`
	Language        string     `db:"language"`
	Company         *string    `db:"company"`
	Position        *string    `db:"position"`
	OwnerID         string     `db:"owner_id"`
	IsPrivate       bool       `db:"is_private"`
	CanViewPlayback bool       `db:"can_view_playback"`
	AllowEdit       bool       `db:"allow_edit"`
	IsPinned        bool       `db:"is_pinned"`
	IsDeleted       bool       `db:"is_deleted"`
	ScheduledTime   *time.Time `db:"scheduled_time"`
	Duration        *int32     `db:"duration"`
	IsEnded         bool       `db:"is_ended"`
	EndedAt         *time.Time `db:"ended_at"`
	CreatedAt       time.Time  `db:"created_at"`
	UpdatedAt       time.Time  `db:"updated_at"`
	OwnerUsername   string     `db:"owner_username"`
}

type RoomParticipantRow struct {
	ID       string    `db:"id"`
	RoomID   string    `db:"room_id"`
	UserID   string    `db:"user_id"`
	CanEdit  bool      `db:"can_edit"`
	JoinedAt time.Time `db:"joined_at"`
}

type RoomParticipantWithUserRow struct {
	ID           string    `db:"id"`
	RoomID       string    `db:"room_id"`
	UserID       string    `db:"user_id"`
	CanEdit      bool      `db:"can_edit"`
	CanReplay    bool      `db:"can_replay"`
	ShareLinkID  *string   `db:"share_link_id"`
	JoinedAt     time.Time `db:"joined_at"`
	UserUsername string    `db:"user_username"`
	UserColor    string    `db:"user_color"`
}

type RoomShareLinkRow struct {
	ID         string     `db:"id"`
	RoomID     string     `db:"room_id"`
	Token      string     `db:"token"`
	CanEdit    bool       `db:"can_edit"`
	CreatedBy  string     `db:"created_by"`
	CreatedAt  time.Time  `db:"created_at"`
	ExpiresAt  time.Time  `db:"expires_at"`
	ConsumedAt *time.Time `db:"consumed_at"`
}

type ShareLinkWithRoomRow struct {
	ID            string     `db:"id"`
	Token         string     `db:"token"`
	CanEdit       bool       `db:"can_edit"`
	CreatedAt     time.Time  `db:"created_at"`
	ExpiresAt     time.Time  `db:"expires_at"`
	ConsumedAt    *time.Time `db:"consumed_at"`
	RoomID        string     `db:"room_id"`
	RoomName      string     `db:"room_name"`
	RoomLanguage  string     `db:"room_language"`
	RoomAllowEdit bool       `db:"room_allow_edit"`
	RoomIsDeleted bool       `db:"room_is_deleted"`
	RoomIsEnded   bool       `db:"room_is_ended"`
	RoomEndedAt   *time.Time `db:"room_ended_at"`
}

type ShareLinkSummaryRow struct {
	ID         string     `db:"id"`
	Token      string     `db:"token"`
	CanEdit    bool       `db:"can_edit"`
	CreatedAt  time.Time  `db:"created_at"`
	ExpiresAt  time.Time  `db:"expires_at"`
	ConsumedAt *time.Time `db:"consumed_at"`
	RoomID     string     `db:"room_id"`
	GuestCount int64      `db:"guest_count"`
}

type GuestSessionRow struct {
	ID          string    `db:"id"`
	ShareLinkID string    `db:"share_link_id"`
	RoomID      string    `db:"room_id"`
	Token       string    `db:"token"`
	DisplayName string    `db:"display_name"`
	Email       *string   `db:"email"`
	Color       string    `db:"color"`
	CanEdit     bool      `db:"can_edit"`
	CreatedAt   time.Time `db:"created_at"`
	LastActive  time.Time `db:"last_active"`
}

type DocumentUpdateRow struct {
	ID         string    `db:"id"`
	DocumentID string    `db:"document_id"`
	Update     []byte    `db:"update"`
	Timestamp  time.Time `db:"timestamp"`
	UserID     *string   `db:"user_id"`
}

type RoomNoteRow struct {
	ID        string    `db:"id"`
	RoomID    string    `db:"room_id"`
	Text      string    `db:"text"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

type NotificationRow struct {
	ID        string    `db:"id"`
	Title     string    `db:"title"`
	Content   string    `db:"content"`
	Severity  string    `db:"severity"`
	CreatedBy string    `db:"created_by"`
	CreatedAt time.Time `db:"created_at"`
}

type NotificationReadRow struct {
	ID             string    `db:"id"`
	NotificationID string    `db:"notification_id"`
	UserID         string    `db:"user_id"`
	ReadAt         time.Time `db:"read_at"`
}
