package server

import (
	"context"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

// --- the first admin (core/admin.rs) ---

// initializeAdmin makes sure there is an admin: the configured account is
// created, or promoted if the name is taken, and with ADMIN_UPDATE_PASSWORD
// an existing admin's password is set again.
func (a *App) initializeAdmin(ctx context.Context) error {
	config := a.Config
	type adminRow struct {
		ID       string `db:"id"`
		Username string `db:"username"`
	}
	existing, err := queryOptional[adminRow](ctx, a.DB, `SELECT id, username FROM "User"
        WHERE role = 'admin' AND "isDeleted" = false LIMIT 1`)
	if err != nil {
		return dbError(err, "Failed to check for admin")
	}
	hashPassword := func() (string, error) {
		if message := validatePassword(config.AdminPassword); message != "" {
			return "", internalError("ADMIN_PASSWORD does not satisfy password policy: " + message)
		}
		hashed, err := bcrypt.GenerateFromPassword([]byte(config.AdminPassword), 12)
		if err != nil {
			return "", internalError("Failed to hash admin password: " + err.Error())
		}
		return string(hashed), nil
	}
	if existing != nil {
		slog.Info("Admin already exists: " + existing.Username)
		if config.AdminUpdatePassword {
			hashed, err := hashPassword()
			if err != nil {
				return err
			}
			if _, err := a.DB.Exec(ctx, `UPDATE "User" SET password = $1, "tokenVersion" = "tokenVersion" + 1 WHERE id = $2`, hashed, existing.ID); err != nil {
				return dbError(err, "Failed to update admin password")
			}
			slog.Info("   Admin password updated")
		}
		return nil
	}
	named, err := queryOptional[adminRow](ctx, a.DB, `SELECT id, username FROM "User" WHERE username = $1 LIMIT 1`, config.AdminUsername)
	if err != nil {
		return dbError(err, "Failed to check admin username")
	}
	if named != nil {
		if _, err := a.DB.Exec(ctx, `UPDATE "User" SET role = 'admin' WHERE id = $1`, named.ID); err != nil {
			return dbError(err, "Failed to promote user to admin")
		}
		slog.Info("Promoted existing user to admin: " + named.Username)
		return nil
	}
	hashed, err := hashPassword()
	if err != nil {
		return err
	}
	if _, err := a.DB.Exec(ctx, `INSERT INTO "User" (id, email, username, password, color, role)
        VALUES ($1, $2, $3, $4, $5, 'admin')`, uuid.NewString(), config.AdminEmail, config.AdminUsername, hashed, randomUserColor()); err != nil {
		return dbError(err, "Failed to create admin")
	}
	slog.Info("Admin created: " + config.AdminUsername)
	slog.Info("   Email: " + config.AdminEmail)
	slog.Warn("   [WARNING] Please change the default password in production!")
	return nil
}

// --- rooms nobody uses (core/room_activity.rs) ---

const roomInactivityTimeoutHours = 6

const cleanupInterval = 5 * time.Minute

// every runs fn now and then at each interval, until ctx ends.
func every(ctx context.Context, interval time.Duration, fn func(trigger string)) {
	go func() {
		fn("startup")
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				fn("interval")
			}
		}
	}()
}

func (a *App) spawnInactiveRoomCleanup(ctx context.Context) {
	slog.Info("inactive room cleanup task started", "interval_seconds", int(cleanupInterval.Seconds()), "inactivity_timeout_hours", roomInactivityTimeoutHours)
	every(ctx, cleanupInterval, func(trigger string) {
		slog.Info("running inactive room cleanup", "trigger", trigger)
		count, err := a.autoEndInactiveRooms(ctx)
		if err != nil {
			slog.Error("failed to auto-end inactive rooms", "error", err)
			return
		}
		slog.Info("inactive room cleanup completed", "trigger", trigger, "ended", count)
	})
}

// autoEndInactiveRooms ends the rooms nobody has touched for six hours,
// except pinned ones, occupied ones and the rooms of scheduled sessions.
func (a *App) autoEndInactiveRooms(ctx context.Context) (int, error) {
	a.WS.access.Lock()
	defer a.WS.access.Unlock()
	occupied := a.WS.OccupiedRooms()
	type endedRow struct {
		ID      string    `db:"id"`
		EndedAt time.Time `db:"ended_at"`
	}
	ended, err := queryAll[endedRow](ctx, a.DB, `UPDATE "Room"
        SET "isEnded" = true, "endedAt" = NOW(), "updatedAt" = NOW()
        WHERE "isDeleted" = false
          AND "isEnded" = false
          AND "isPinned" = false
          AND NOT (id = ANY($2))
          AND "updatedAt" <= NOW() - ($1 * INTERVAL '1 hour')
          -- A scheduled session's room is ended by hand, never for inactivity:
          -- it may be opened well ahead and used again after the session.
          AND NOT EXISTS (SELECT 1 FROM "Appointment" a WHERE a."roomId" = "Room".id)
        RETURNING id, "endedAt" as ended_at`, roomInactivityTimeoutHours, occupied)
	if err != nil {
		return 0, err
	}
	for _, room := range ended {
		a.broadcastRoomEnded(ctx, room.ID, room.EndedAt)
	}
	return len(ended), nil
}

// touchRoomActivity marks a live room as used now.
func touchRoomActivity(ctx context.Context, db DBTX, roomID string) error {
	_, err := db.Exec(ctx, `UPDATE "Room" SET "updatedAt" = NOW()
        WHERE id = $1 AND "isDeleted" = false AND "isEnded" = false`, roomID)
	return err
}

// --- share links nobody used (core/share_links.rs) ---

// guestShareTTLHours is how long a share link and a guest's token last.
const guestShareTTLHours = 6

func (a *App) spawnExpiredShareLinkCleanup(ctx context.Context) {
	slog.Info("expired share link cleanup task started", "interval_seconds", int(cleanupInterval.Seconds()), "share_ttl_hours", guestShareTTLHours)
	every(ctx, cleanupInterval, func(trigger string) {
		slog.Info("running expired share link cleanup", "trigger", trigger)
		count, err := cleanupExpiredShareLinks(ctx, a.DB)
		if err != nil {
			slog.Error("failed to clean up expired share links", "error", err)
			return
		}
		slog.Info("expired share link cleanup completed", "trigger", trigger, "deleted", count)
	})
}

func cleanupExpiredShareLinks(ctx context.Context, db DBTX) (int64, error) {
	tag, err := db.Exec(ctx, `DELETE FROM "RoomShareLink" WHERE "consumedAt" IS NULL AND "expiresAt" <= NOW()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
