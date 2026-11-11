package server

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ClientInfo is where a request came from, for the audit log.
type ClientInfo struct {
	IP          netip.Addr
	Peer        netip.Addr
	Source      string
	UserAgent   string
	RequestID   string
	DeviceID    *uuid.UUID
	Fingerprint *string
	NewDevice   bool
}

func truncateChars(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// visibleASCII returns a header value if it is what HeaderValue::to_str
// accepts (visible ASCII, spaces and tabs), "" otherwise.
func visibleASCII(value string) string {
	for _, c := range []byte(value) {
		if c != '	' && (c < 0x20 || c >= 0x7f) {
			return ""
		}
	}
	return value
}

// clientInfo is the ClientInfo extractor.
func (a *App) clientInfo(r *http.Request) (*ClientInfo, error) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return nil, internalError("Missing peer address")
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return nil, internalError("Missing peer address")
	}
	peer = peer.Unmap()
	ip, source := clientIP(peer, r.Header, a.Config.TrustedProxyCIDRs)
	info := &ClientInfo{
		IP: ip, Peer: peer, Source: source,
		UserAgent: truncateChars(visibleASCII(r.Header.Get("User-Agent")), 512),
		RequestID: uuid.NewString(),
	}
	if id, err := uuid.Parse(r.Header.Get("X-Device-Id")); err == nil {
		info.DeviceID = &id
	}
	if fp := r.Header.Get("X-Device-Fingerprint"); validFingerprint(fp) {
		info.Fingerprint = &fp
	}
	return info, nil
}

// validFingerprint: advisory, client-provided identifiers, never
// authorization evidence.
func validFingerprint(value string) bool {
	hash, ok := strings.CutPrefix(value, "fp5:")
	if !ok || len(hash) != 32 {
		return false
	}
	for _, c := range []byte(hash) {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// identifyLoginDevice records the device a login came from and sets
// client.NewDevice.
func identifyLoginDevice(ctx context.Context, tx DBTX, client *ClientInfo, userID string) error {
	if client.DeviceID == nil {
		return nil
	}
	tag, err := tx.Exec(ctx, `INSERT INTO "UserDevice" ("userId", "deviceId", fingerprint,"userAgent","lastIp")
        VALUES ($1,$2,$3,$4,$5::inet) ON CONFLICT DO NOTHING`,
		userID, *client.DeviceID, client.Fingerprint, client.UserAgent, client.IP.String())
	if err != nil {
		return dbError(err, "Failed to register login device")
	}
	client.NewDevice = tag.RowsAffected() == 1
	if !client.NewDevice {
		if _, err := tx.Exec(ctx, `UPDATE "UserDevice" SET "lastSeen"=NOW(), fingerprint=COALESCE($3, fingerprint), "userAgent"=$4,"lastIp"=$5::inet,"loginCount"="loginCount"+1
            WHERE "userId"=$1 AND "deviceId"=$2`,
			userID, *client.DeviceID, client.Fingerprint, client.UserAgent, client.IP.String()); err != nil {
			return dbError(err, "Failed to update login device")
		}
	}
	return nil
}

func inNetwork(ip netip.Addr, cidr string) bool {
	if !strings.Contains(cidr, "/") {
		if strings.Contains(cidr, ":") {
			cidr += "/128"
		} else {
			cidr += "/32"
		}
	}
	network, bits, _ := strings.Cut(cidr, "/")
	addr, err := netip.ParseAddr(network)
	n, err2 := strconv.Atoi(bits)
	if err != nil || err2 != nil || n < 0 || addr.Is4() != ip.Is4() || n > addr.BitLen() {
		return false
	}
	prefix, err := addr.Prefix(n)
	return err == nil && prefix.Contains(ip)
}

// clientIP walks X-Forwarded-For from the peer backwards through trusted
// proxies only.
func clientIP(peer netip.Addr, header http.Header, trusted []string) (netip.Addr, string) {
	isTrusted := func(ip netip.Addr) bool {
		for _, cidr := range trusted {
			if inNetwork(ip, cidr) {
				return true
			}
		}
		return false
	}
	if !isTrusted(peer) {
		return peer, "socket"
	}
	var hops []netip.Addr
	for _, raw := range header.Values("X-Forwarded-For") {
		for _, hop := range strings.Split(raw, ",") {
			ip, err := netip.ParseAddr(strings.TrimSpace(hop))
			if err != nil {
				return peer, "socket-invalid-forwarded"
			}
			hops = append(hops, ip)
			if len(hops) > 32 {
				return peer, "socket-invalid-forwarded"
			}
		}
	}
	if len(hops) == 0 {
		return peer, "socket"
	}
	current := peer
	for i := len(hops) - 1; i >= 0; i-- {
		if !isTrusted(current) {
			break
		}
		current = hops[i]
	}
	return current, "trusted-proxy"
}

// record writes an audit event. Call it inside the mutation's transaction
// where there is one. No password, token, authorization header, email or
// request body is ever captured.
func record(ctx context.Context, db DBTX, client *ClientInfo, action string, actor, username, target *string, success bool, reason *string) error {
	return recordDetails(ctx, db, client, action, actor, username, target, success, reason, nil, map[string]any{})
}

func recordDetails(ctx context.Context, db DBTX, client *ClientInfo, action string, actor, username, target *string, success bool, reason, roomID *string, details any) error {
	if username != nil {
		username = ptr(truncateChars(*username, 128))
	}
	if details == nil {
		details = map[string]any{}
	}
	_, err := db.Exec(ctx, `INSERT INTO "AuditEvent" (action,"actorId",username,"targetId",success,"clientIp","peerIp","ipSource","userAgent","requestId",reason,"deviceId",fingerprint,"newDevice","roomId",details)
        VALUES ($1,$2,$3,$4,$5,$6::inet,$7::inet,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
		action, actor, username, target, success, client.IP.String(), client.Peer.String(), client.Source,
		client.UserAgent, client.RequestID, reason, client.DeviceID, client.Fingerprint, client.NewDevice, roomID, details)
	if err != nil {
		slog.Error("audit write failed", "error", err, "action", action)
		return serviceUnavailable("Audit storage unavailable; retry later")
	}
	return nil
}

// auditQuery is the query string of the audit and device lists.
type auditQuery struct {
	Page     *uint32
	PageSize *uint32
	Action   *string
	Username *string
	Start    *time.Time
	End      *time.Time
	Snapshot *int64
	DeviceID *uuid.UUID
}

// queryRejection answers as axum's Query extractor does for a value that
// does not parse.
func queryRejection(err error) error {
	return &plainError{http.StatusBadRequest, "Failed to deserialize query string: " + err.Error()}
}

func parseAuditQuery(r *http.Request) (*auditQuery, error) {
	values := r.URL.Query()
	q := &auditQuery{}
	number := func(key string, bits int) (*uint64, error) {
		if !values.Has(key) {
			return nil, nil
		}
		n, err := strconv.ParseUint(values.Get(key), 10, bits)
		if err != nil {
			return nil, queryRejection(err)
		}
		return &n, nil
	}
	if n, err := number("page", 32); err != nil {
		return nil, err
	} else if n != nil {
		q.Page = ptr(uint32(*n))
	}
	if n, err := number("pageSize", 32); err != nil {
		return nil, err
	} else if n != nil {
		q.PageSize = ptr(uint32(*n))
	}
	if values.Has("action") {
		q.Action = ptr(values.Get("action"))
	}
	if values.Has("username") {
		q.Username = ptr(values.Get("username"))
	}
	for key, target := range map[string]**time.Time{"start": &q.Start, "end": &q.End} {
		if values.Has(key) {
			t, err := time.Parse(time.RFC3339Nano, values.Get(key))
			if err != nil {
				return nil, queryRejection(err)
			}
			*target = &t
		}
	}
	if values.Has("snapshot") {
		n, err := strconv.ParseInt(values.Get("snapshot"), 10, 64)
		if err != nil {
			return nil, queryRejection(err)
		}
		q.Snapshot = &n
	}
	if values.Has("deviceId") {
		id, err := uuid.Parse(values.Get("deviceId"))
		if err != nil {
			return nil, queryRejection(err)
		}
		q.DeviceID = &id
	}
	return q, nil
}

type auditRow struct {
	ID          int64      `db:"id" json:"id"`
	CreatedAt   Time       `db:"created_at" json:"createdAt"`
	Action      string     `db:"action" json:"action"`
	ActorID     *string    `db:"actor_id" json:"actorId"`
	Username    *string    `db:"username" json:"username"`
	TargetID    *string    `db:"target_id" json:"targetId"`
	Success     bool       `db:"success" json:"success"`
	ClientIP    string     `db:"client_ip" json:"clientIp"`
	PeerIP      string     `db:"peer_ip" json:"peerIp"`
	IPSource    string     `db:"ip_source" json:"ipSource"`
	UserAgent   string     `db:"user_agent" json:"userAgent"`
	RequestID   string     `db:"request_id" json:"requestId"`
	Reason      *string    `db:"reason" json:"reason"`
	DeviceID    *uuid.UUID `db:"device_id" json:"deviceId"`
	Fingerprint *string    `db:"fingerprint" json:"fingerprint"`
	NewDevice   bool       `db:"new_device" json:"newDevice"`
	Details     any        `db:"details" json:"details"`
}

// pagination is the paging block the admin lists answer with.
func pagination(page, size, total, pages int64) map[string]any {
	return map[string]any{"page": page, "pageSize": size, "total": total, "totalPages": pages,
		"hasNext": page < pages, "hasPrev": page > 1}
}

func clampPage(q *auditQuery, defaultSize uint32, total int64) (page, size, pages int64) {
	s := defaultSize
	if q.PageSize != nil {
		s = *q.PageSize
	}
	size = int64(min(max(s, 1), 100))
	pages = (total + size - 1) / size
	p := uint32(1)
	if q.Page != nil {
		p = *q.Page
	}
	page = min(int64(max(p, 1)), max(pages, 1))
	return page, size, pages
}

// listAuditEvents is GET /api/admin/audit.
func (a *App) listAuditEvents(w http.ResponseWriter, r *http.Request) error {
	user, err := a.adminUser(r)
	if err != nil {
		return err
	}
	query, err := parseAuditQuery(r)
	if err != nil {
		return err
	}
	if query.Start != nil && query.End != nil && query.Start.After(*query.End) {
		return badRequest("Start must be before end")
	}
	ctx := r.Context()
	tx, err := a.DB.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return dbError(err, "Failed to load audit")
	}
	defer tx.Rollback(context.Background())
	var snapshot int64
	switch {
	case query.Snapshot != nil && *query.Snapshot >= 0:
		snapshot = *query.Snapshot
	case query.Snapshot != nil:
		return badRequest("Invalid audit snapshot")
	default:
		if snapshot, err = scalar[int64](ctx, tx, `SELECT COALESCE(MAX(id),0) FROM "AuditEvent"`); err != nil {
			return dbError(err, "Failed to load audit")
		}
	}
	action, username := query.Action, query.Username
	if action != nil && *action == "" {
		action = nil
	}
	if username != nil && *username == "" {
		username = nil
	}
	// Audit must not become a side channel into inaccessible private rooms.
	const filter = `FROM "AuditEvent" a WHERE a.id <= $1
        AND ($2::text IS NULL OR a.action=$2) AND ($3::text IS NULL OR a.username=$3)
        AND ($4::timestamptz IS NULL OR a."createdAt">=$4) AND ($5::timestamptz IS NULL OR a."createdAt"<=$5)
        AND ($6::uuid IS NULL OR a."deviceId"=$6)
        AND (a."roomId" IS NULL OR EXISTS (
            SELECT 1 FROM "Room" r JOIN "User" o ON o.id=r."ownerId" WHERE r.id=a."roomId"
            AND (NOT r."isPrivate" OR room_is_visible($7,$8,$9,r."ownerId",o.role,true,false,r."isEnded",false,
                EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId"=r.id AND p."userId"=$7),false))
        ))`
	args := []any{snapshot, action, username, query.Start, query.End, query.DeviceID, user.ID, user.Role, hasGlobalRead(user)}
	total, err := scalar[int64](ctx, tx, "SELECT COUNT(*) "+filter, args...)
	if err != nil {
		return dbError(err, "Failed to count audit events")
	}
	page, size, pages := clampPage(query, 25, total)
	rows, err := queryAll[auditRow](ctx, tx, `SELECT a.id,a."createdAt" as created_at,a.action,a."actorId" as actor_id,a.username,a."targetId" as target_id,
        a.success,host(a."clientIp") as client_ip,host(a."peerIp") as peer_ip,a."ipSource" as ip_source,a."userAgent" as user_agent,a."requestId" as request_id,a.reason,
        a."deviceId" as device_id,a.fingerprint,a."newDevice" as new_device,a.details
        `+filter+` ORDER BY a."createdAt" DESC,a.id DESC LIMIT $10 OFFSET $11`, append(args, size, (page-1)*size)...)
	if err != nil {
		return dbError(err, "Failed to load audit events")
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to load audit events")
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": rows, "snapshot": snapshot, "pagination": pagination(page, size, total, pages)})
	return nil
}

type deviceRow struct {
	DeviceID    uuid.UUID `db:"device_id" json:"deviceId"`
	Fingerprint *string   `db:"fingerprint" json:"fingerprint"`
	UserAgent   string    `db:"user_agent" json:"userAgent"`
	LastIP      string    `db:"last_ip" json:"lastIp"`
	FirstSeen   Time      `db:"first_seen" json:"firstSeen"`
	LastSeen    Time      `db:"last_seen" json:"lastSeen"`
	LoginCount  int64     `db:"login_count" json:"loginCount"`
}

// listUserDevices is GET /api/admin/users/{id}/devices.
func (a *App) listUserDevices(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.adminUser(r); err != nil {
		return err
	}
	userID := r.PathValue("id")
	query, err := parseAuditQuery(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if found, err := scalarOptional[int32](ctx, a.DB, `SELECT 1 FROM "User" WHERE id=$1 AND NOT "isDeleted"`, userID); err != nil {
		return dbError(err, "Failed to load user")
	} else if found == nil {
		return notFound("User not found")
	}
	total, err := scalar[int64](ctx, a.DB, `SELECT COUNT(*) FROM "UserDevice" WHERE "userId"=$1`, userID)
	if err != nil {
		return dbError(err, "Failed to load devices")
	}
	page, size, pages := clampPage(query, 10, total)
	rows, err := queryAll[deviceRow](ctx, a.DB, `SELECT "deviceId" as device_id,fingerprint,"userAgent" as user_agent,
        host("lastIp") as last_ip,"firstSeen" as first_seen,"lastSeen" as last_seen,"loginCount" as login_count
        FROM "UserDevice" WHERE "userId"=$1 ORDER BY "lastSeen" DESC,"deviceId" LIMIT $2 OFFSET $3`, userID, size, (page-1)*size)
	if err != nil {
		return dbError(err, "Failed to load devices")
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": rows, "pagination": pagination(page, size, total, pages)})
	return nil
}
