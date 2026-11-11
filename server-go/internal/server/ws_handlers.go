package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Deln0r/ygo"
	"github.com/coder/websocket"
)

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		mux.HandleFunc("GET /api/ws", a.wsHandler)
	})
}

// --- who is on the socket (ws/auth.rs) ---

// authOutcome is what a token gives a connection on a document.
type authOutcome struct {
	readOnly       bool
	actorID        *string
	loginSessionID *string
	shareLinkID    *string
	expiresAt      int64
	username       string
}

// wsAuthenticate checks a token for a document. The error text is what the
// client is told; "Authentication temporarily unavailable: …" marks a
// failure of the server's own.
func (a *App) wsAuthenticate(ctx context.Context, documentName, token string) (*authOutcome, string) {
	if token == "" {
		return nil, "Authentication failed: No authentication token provided"
	}
	payload, err := verifyToken(a.Config, token)
	if err != nil {
		return nil, "Authentication failed: " + err.Error()
	}
	if payload.User != nil {
		return a.wsAuthenticateUser(ctx, documentName, payload.User)
	}
	return a.wsAuthenticateGuest(ctx, documentName, payload.Guest)
}

func (a *App) wsAuthenticateUser(ctx context.Context, documentName string, payload *UserTokenPayload) (*authOutcome, string) {
	type combinedRow struct {
		TokenVersion           int64   `db:"token_version"`
		Username               string  `db:"username"`
		UserID                 string  `db:"user_id"`
		Role                   string  `db:"role"`
		UserIsDeleted          bool    `db:"user_is_deleted"`
		OwnerID                string  `db:"owner_id"`
		CanView                bool    `db:"can_view"`
		IsEnded                bool    `db:"is_ended"`
		ParticipantCanEdit     *bool   `db:"participant_can_edit"`
		ParticipantShareLinkID *string `db:"participant_share_link_id"`
	}
	row, err := queryOptional[combinedRow](ctx, a.DB, `
        SELECT
            u.id as user_id,
            u.role,
            u.username,
            u."tokenVersion" as token_version,
            u."isDeleted" as user_is_deleted,
            r."ownerId" as owner_id,
            r."isEnded" as is_ended,
            room_is_visible(u.id, u.role, room_role_rank(u.role) > 0,
                r."ownerId", o.role, r."isPrivate", r."isPinned", r."isEnded", r."isDeleted", p.id IS NOT NULL, COALESCE(p."canReplay", false)) as can_view,
            p."canEdit" as participant_can_edit,
            p."shareLinkId" as participant_share_link_id
        FROM "User" u
        CROSS JOIN "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        LEFT JOIN "RoomParticipant" p ON p."roomId" = r.id AND p."userId" = u.id
        WHERE u.id = $1 AND r.id = $2 AND ($3::text IS NULL OR EXISTS (
            SELECT 1 FROM "BrowserSession" s WHERE s.id=$3 AND s."userId"=u.id
            AND s."tokenVersion"=u."tokenVersion" AND s."expiresAt">NOW()))`,
		payload.UserID, documentName, payload.SessionID)
	if err != nil {
		return nil, "Authentication temporarily unavailable: " + dbError(err, "Failed to load auth data").Error()
	}
	if row == nil || row.UserIsDeleted || row.TokenVersion != payload.TokenVersion {
		return nil, "Authentication failed: User or Room not found"
	}
	if !row.CanView {
		return nil, "Authentication failed: Access denied"
	}
	canEdit := canEditRoomContent(row.IsEnded, row.OwnerID == row.UserID, isStaff(row.Role), row.ParticipantCanEdit)
	userID := row.UserID
	go func() {
		_, _ = a.DB.Exec(context.Background(), `UPDATE "User" SET "lastSeen" = NOW() WHERE id = $1`, userID)
	}()
	return &authOutcome{readOnly: !canEdit, actorID: &row.UserID, loginSessionID: payload.SessionID,
		shareLinkID: row.ParticipantShareLinkID, expiresAt: payload.Exp, username: row.Username}, ""
}

func (a *App) wsAuthenticateGuest(ctx context.Context, documentName string, payload *GuestTokenPayload) (*authOutcome, string) {
	type guestRow struct {
		DisplayName   string `db:"display_name"`
		ID            string `db:"id"`
		Token         string `db:"token"`
		CanEdit       bool   `db:"can_edit"`
		RoomID        string `db:"room_id"`
		RoomAllowEdit bool   `db:"room_allow_edit"`
		RoomIsDeleted bool   `db:"room_is_deleted"`
		RoomIsEnded   bool   `db:"room_is_ended"`
		ShareCanEdit  bool   `db:"share_can_edit"`
	}
	guest, err := queryOptional[guestRow](ctx, a.DB, `
        SELECT
            g.id,
            g.token,
            g."displayName" as display_name,
            g."canEdit" as can_edit,
            r.id as room_id,
            r."allowEdit" as room_allow_edit,
            r."isDeleted" as room_is_deleted,
            r."isEnded" as room_is_ended,
            l."canEdit" as share_can_edit
        FROM "GuestSession" g
        JOIN "Room" r ON r.id = g."roomId"
        JOIN "RoomShareLink" l ON l.id = g."shareLinkId"
        WHERE g.id = $1 AND g."shareLinkId" = $2 AND l."roomId" = g."roomId"`,
		payload.GuestID, payload.ShareLinkID)
	if err != nil {
		return nil, "Authentication temporarily unavailable: " + dbError(err, "Failed to load guest session").Error()
	}
	if guest == nil {
		return nil, "Authentication failed: Guest session not found"
	}
	if guest.Token != payload.SessionToken {
		return nil, "Authentication failed: Guest session token mismatch"
	}
	if guest.RoomID != documentName || payload.RoomID != documentName {
		return nil, "Authentication failed: Guest session does not match this document"
	}
	if guest.RoomIsDeleted || guest.RoomIsEnded {
		return nil, "Authentication failed: Room is no longer available"
	}
	effectiveCanEdit := guest.CanEdit && guest.RoomAllowEdit && guest.ShareCanEdit
	if _, err := a.DB.Exec(ctx, `UPDATE "GuestSession" SET "lastActive" = $2, "canEdit" = $3 WHERE id = $1`,
		guest.ID, time.Now().UTC(), effectiveCanEdit); err != nil {
		return nil, "Authentication temporarily unavailable: " + dbError(err, "Failed to update guest session").Error()
	}
	return &authOutcome{readOnly: !effectiveCanEdit, actorID: &guest.ID, shareLinkID: &payload.ShareLinkID,
		expiresAt: payload.Exp, username: guest.DisplayName}, ""
}

// --- the socket (ws/handlers.rs) ---

// sessionState is one document on one socket.
type sessionState struct {
	authenticated    bool
	expiresAt        int64
	readOnly         bool
	actorID          *string
	sessionColor     *SessionColor
	document         *DocumentState
	pendingSyncStep1 []byte // a state vector that arrived before the token
	awarenessClients map[uint64]struct{}
}

// maxSocketMessage is the largest message a client may send.
const maxSocketMessage = 2 * 1024 * 1024

// socket is one WebSocket connection: the documents on it, and its queue.
type socket struct {
	app      *App
	id       ConnectionID
	conn     *websocket.Conn
	outgoing *Outbound

	// mu guards sessions: the read loop handles one frame at a time under
	// it, and the heartbeat reads them between frames.
	mu       sync.Mutex
	sessions map[string]*sessionState

	lastPong atomic.Int64 // unix nanoseconds
}

func (a *App) wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The socket carries its own authentication (a token per
		// document); the origin is not part of it, as in server-rs.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	conn.SetReadLimit(maxSocketMessage)
	s := &socket{app: a, id: a.WS.newConnectionID(), conn: conn, outgoing: newOutbound(), sessions: map[string]*sessionState{}}
	s.lastPong.Store(time.Now().UnixNano())
	slog.Info("ws connection opened", "connection_id", s.id)

	// The request's context ends when the handler returns; the socket's
	// own ends when any of its three loops does.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go s.writeLoop(ctx, cancel)
	go s.heartbeat(ctx, cancel)
	s.readLoop(ctx)
	cancel()

	s.cleanup()
	slog.Info("ws connection closed", "connection_id", s.id)
	_ = conn.CloseNow()
}

// writeLoop writes what is queued. A close with a reason (a revocation, a
// slow reader) goes ahead of the queue, with code 4403.
func (s *socket) writeLoop(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	closeWithReason := func() {
		reason := "Connection closed"
		if r := s.outgoing.reason.Load(); r != nil {
			reason = *r
		}
		done := make(chan struct{})
		go func() { _ = s.conn.Close(4403, reason); close(done) }()
		select {
		case <-done:
		case <-time.After(time.Second):
		}
	}
	for {
		select {
		case <-s.outgoing.closed:
			closeWithReason()
			return
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-s.outgoing.closed:
			closeWithReason()
			return
		case frame := <-s.outgoing.frames:
			if frame.kind == frameClose {
				s.outgoing.release(frame)
				_ = s.conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			writeCtx, done := context.WithTimeout(ctx, 5*time.Second)
			err := s.conn.Write(writeCtx, websocket.MessageBinary, frame.data)
			done()
			s.outgoing.release(frame)
			if err != nil {
				return
			}
		}
	}
}

// heartbeat pings the peer, drops it when it has not answered for 45
// seconds or a session's token has expired, and sends each document's
// presence and a "heartbeat" message: browser JavaScript cannot observe
// WebSocket pings, and the provider's watchdog needs to see activity.
func (s *socket) heartbeat(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if time.Since(time.Unix(0, s.lastPong.Load())) > 45*time.Second {
			cancel()
			return
		}
		go func() {
			pingCtx, done := context.WithTimeout(ctx, 40*time.Second)
			defer done()
			if s.conn.Ping(pingCtx) == nil {
				s.lastPong.Store(time.Now().UnixNano())
			}
		}()
		now := time.Now().Unix()
		s.mu.Lock()
		expired := false
		for name, session := range s.sessions {
			if session.authenticated && session.expiresAt <= now {
				expired = true
				break
			}
			if session.document != nil {
				session.document.sendPresence(name, s.outgoing)
			}
			s.outgoing.send(encodeStatelessMessage(name, `{"type":"heartbeat"}`))
		}
		s.mu.Unlock()
		if expired {
			cancel()
			return
		}
	}
}

func (s *socket) readLoop(ctx context.Context) {
	for {
		kind, data, err := s.conn.Read(ctx)
		if err != nil {
			return
		}
		if kind != websocket.MessageBinary {
			continue
		}
		s.mu.Lock()
		err = s.handleBinaryMessage(ctx, data)
		s.mu.Unlock()
		if err != nil {
			slog.Error("ws message handling failed", "error", err)
			return
		}
	}
}

func (s *socket) handleBinaryMessage(ctx context.Context, data []byte) error {
	documentName, messageType, payload, err := decodeFrame(data)
	if err != nil {
		slog.Warn("ws frame decode failed", "connection_id", s.id, "data_len", len(data), "error", err)
		return err
	}
	access := &s.app.WS.access
	access.RLock()
	defer access.RUnlock()

	session := s.sessions[documentName]
	if session == nil {
		if len(s.sessions) >= 8 {
			return errWsBackpressure
		}
		session = &sessionState{readOnly: true, awarenessClients: map[uint64]struct{}{}}
		s.sessions[documentName] = session
	}

	if messageType != msgAuth && session.authenticated {
		expired := session.expiresAt <= time.Now().Unix()
		attached := session.document != nil && session.document.hasConnection(s.id)
		if expired || !attached {
			session.authenticated = false
			reason := "Access revoked"
			if expired {
				reason = "Session expired"
			}
			s.sendAuthDenied(documentName, reason)
			s.outgoing.sendClose()
			return nil
		}
	}

	switch messageType {
	case msgAuth:
		return s.handleAuth(ctx, session, documentName, payload)
	case msgSync:
		return s.handleSync(session, documentName, payload)
	case msgAwareness:
		return s.handleAwareness(session, documentName, payload)
	case msgQueryAwareness:
		if session.authenticated && session.document != nil {
			s.sendAwarenessSnapshot(session.document, documentName)
		}
	case msgStateless:
		return s.handleStateless(session, documentName, payload)
	case msgClose:
		s.outgoing.sendClose()
	}
	return nil
}

func (s *socket) sendAuthDenied(documentName, reason string) {
	s.outgoing.send(encodeAuthMessage(documentName, authPermissionDenied, &reason))
}

func scopeOf(readOnly bool) *string {
	if readOnly {
		return ptr("readonly")
	}
	return ptr("read-write")
}

func (s *socket) handleAuth(ctx context.Context, session *sessionState, documentName string, payload []byte) error {
	authType, token, err := decodeAuth(payload)
	if err != nil {
		return err
	}
	// Same-identity renewal is allowed; changing actors requires a new socket.
	if authType != authToken {
		return nil
	}
	if token == nil {
		s.sendAuthDenied(documentName, "Authentication failed: No authentication token provided")
		return nil
	}

	outcome, reason := s.app.wsAuthenticate(ctx, documentName, *token)
	if outcome == nil {
		session.authenticated = false
		// Database and network failures are retryable, not an access
		// revocation. A normal close lets the provider back off and
		// reconnect.
		if !bytes.HasPrefix([]byte(reason), []byte("Authentication temporarily unavailable:")) {
			s.sendAuthDenied(documentName, reason)
		}
		s.outgoing.sendClose()
		return nil
	}

	if session.document != nil {
		// Refresh credentials in place without detaching the document,
		// dropping awareness, or creating a gap in pending writes.
		attached := session.document.hasConnection(s.id)
		if !session.authenticated || !attached || !sameOptString(session.actorID, outcome.actorID) {
			session.authenticated = false
			s.sendAuthDenied(documentName, "Access revoked")
			s.outgoing.sendClose()
			return nil
		}
		session.expiresAt = outcome.expiresAt
		session.readOnly = outcome.readOnly
		session.document.renewConnectionSession(s.id, outcome.loginSessionID)
		s.outgoing.send(encodeAuthMessage(documentName, authAuthenticated, scopeOf(outcome.readOnly)))
		return nil
	}

	session.authenticated = true
	session.readOnly = outcome.readOnly
	session.actorID = outcome.actorID
	session.expiresAt = outcome.expiresAt
	doc, color, err := s.app.WS.attachDocument(ctx, documentName, s.id, s.outgoing,
		outcome.actorID, outcome.shareLinkID, outcome.loginSessionID, outcome.username)
	if err != nil {
		return err
	}
	slog.Info("ws authenticated", "connection_id", s.id, "document_name", documentName, "read_only", session.readOnly)
	session.document = doc
	session.sessionColor = &color

	s.outgoing.send(encodeAuthMessage(documentName, authAuthenticated, scopeOf(outcome.readOnly)))
	s.outgoing.send(statelessJSON(documentName, map[string]any{
		"type": "session-color", "slot": color.Slot, "color": color.Color, "colorLight": color.ColorLight,
	}))

	if session.pendingSyncStep1 != nil {
		pending := session.pendingSyncStep1
		session.pendingSyncStep1 = nil
		if err := s.sendSyncStep2(doc, documentName, pending); err != nil {
			return err
		}
	}
	s.sendSyncStep1(doc, documentName)
	s.sendAwarenessSnapshot(doc, documentName)
	doc.sendPersistenceStatus(documentName, false)
	doc.broadcastPresence(documentName)
	// Refresh the setting after reconnect, even for read-only clients.
	language, err := scalarOptional[string](ctx, s.app.DB, `SELECT language FROM "Room" WHERE id = $1`, documentName)
	if err != nil {
		return fmt.Errorf("db error: %w", err)
	}
	if language != nil {
		s.outgoing.send(statelessJSON(documentName, map[string]any{"type": "room-language", "language": *language}))
	}
	return nil
}

func (s *socket) sendSyncStep1(doc *DocumentState, documentName string) {
	doc.updateLock.Lock()
	stateVector := ygo.EncodeStateVector(doc.doc)
	doc.updateLock.Unlock()
	s.outgoing.send(encodeSyncMessage(documentName, syncStep1, stateVector))
}

func (s *socket) sendSyncStep2(doc *DocumentState, documentName string, stateVector []byte) error {
	doc.updateLock.Lock()
	update, err := ygo.EncodeDiff(doc.doc, stateVector)
	doc.updateLock.Unlock()
	if err != nil {
		return fmt.Errorf("decode error: %w", err)
	}
	s.outgoing.send(encodeSyncMessage(documentName, syncStep2, update))
	return nil
}

func (s *socket) handleSync(session *sessionState, documentName string, payload []byte) error {
	c := &cursor{data: payload}
	kind, err := c.readVar()
	if err != nil {
		return err
	}
	if kind > syncUpdate {
		return errWsDecode
	}
	body, err := c.readBuf()
	if err != nil {
		return err
	}

	if !session.authenticated {
		if kind == syncStep1 {
			session.pendingSyncStep1 = bytes.Clone(body)
		}
		return nil
	}
	doc := session.document
	if doc == nil {
		return nil
	}
	switch kind {
	case syncStep1:
		if err := s.sendSyncStep2(doc, documentName, body); err != nil {
			return err
		}
		s.sendSyncStep1(doc, documentName)
		return nil
	case syncStep2:
		if session.readOnly {
			s.outgoing.send(encodeMessage(documentName, msgSyncStatus, []byte{1}))
			return nil
		}
	}
	return s.handleUpdateMessage(session, documentName, doc, bytes.Clone(body))
}

// isEmptyUpdate reports whether a version 1 update holds nothing: no
// structs and no deletions.
func isEmptyUpdate(update []byte) bool {
	return len(update) == 2 && update[0] == 0 && update[1] == 0
}

func (s *socket) handleUpdateMessage(session *sessionState, documentName string, doc *DocumentState, update []byte) error {
	doc.updateLock.Lock()
	defer doc.updateLock.Unlock()
	if err := ygo.ValidateUpdate(update); err != nil {
		return fmt.Errorf("decode error: %w", err)
	}
	if !isEmptyUpdate(update) && (session.readOnly || doc.isEnded.Load()) {
		s.sendAuthDenied(documentName, "Document is read-only")
		return nil
	}
	// Reserve capacity before applying anything. Never silently discard an
	// accepted edit, and never wait for database I/O under the room gate.
	// Everything that queues for the writer holds updateLock, so room in
	// the queue now is room when the entry is queued below.
	if doc.pendingBytes.Load()+int64(len(update)) > maxPendingBytes || len(doc.persistence) >= cap(doc.persistence) {
		return errWsBackpressure
	}
	if err := ygo.ApplyUpdate(doc.doc, update); err != nil {
		return fmt.Errorf("apply error: %w", err)
	}
	doc.pendingBytes.Add(int64(len(update)))
	doc.pendingCount.Add(1)
	doc.persistence <- pendingEdit(update, session.actorID, s.id, s.outgoing)
	doc.broadcast(encodeSyncUpdate(documentName, update), &s.id)
	doc.sendPersistenceStatus(documentName, false)
	return nil
}

// awarenessClients lists the clients an awareness update speaks of.
func awarenessClients(update []byte) ([]uint64, error) {
	c := &cursor{data: update}
	count, err := c.readVar()
	if err != nil {
		return nil, err
	}
	clients := make([]uint64, 0, min(count, 64))
	for range count {
		client, err := c.readVar()
		if err != nil {
			return nil, err
		}
		if _, err := c.readVar(); err != nil { // clock
			return nil, err
		}
		if _, err := c.readBuf(); err != nil { // state, as JSON
			return nil, err
		}
		clients = append(clients, client)
	}
	return clients, nil
}

func (s *socket) handleAwareness(session *sessionState, documentName string, payload []byte) error {
	if !session.authenticated || session.document == nil {
		return nil
	}
	update, err := decodeVarBytes(payload)
	if err != nil {
		return err
	}
	clients, err := awarenessClients(update)
	if err != nil {
		return err
	}
	for _, client := range clients {
		session.awarenessClients[client] = struct{}{}
	}
	if _, err := session.document.awareness.Apply(update, s.id); err != nil {
		return fmt.Errorf("awareness error: %w", err)
	}
	session.document.broadcast(encodeMessage(documentName, msgAwareness, appendBuf(nil, update)), &s.id)
	return nil
}

func (s *socket) sendAwarenessSnapshot(doc *DocumentState, documentName string) {
	s.outgoing.send(encodeMessage(documentName, msgAwareness, appendBuf(nil, doc.awareness.Encode(nil))))
}

func (s *socket) handleStateless(session *sessionState, documentName string, payload []byte) error {
	if !session.authenticated || session.document == nil {
		return nil
	}
	doc := session.document
	text, err := (&cursor{data: payload}).readString()
	if err != nil {
		return err
	}
	var message map[string]any
	if json.Unmarshal([]byte(text), &message) != nil {
		return nil
	}
	switch message["type"] {
	case "presence":
		// A whole number that fits 32 bits, as the client IDs of Yjs are.
		if n, ok := message["clientId"].(float64); ok && n >= 0 && n <= 4294967295 && n == float64(uint64(n)) {
			doc.registerPresence(documentName, s.id, uint64(n))
		}
	case "durability-barrier":
		id, ok := message["id"].(string)
		if !ok || len(id) > 100 {
			return nil
		}
		doc.updateLock.Lock()
		defer doc.updateLock.Unlock()
		if len(doc.persistence) >= cap(doc.persistence) {
			return errWsBackpressure
		}
		if outgoing := doc.connectionSender(s.id); outgoing != nil {
			doc.pendingCount.Add(1)
			doc.persistence <- pendingBarrier(id, s.id, outgoing)
		}
	}
	return nil
}

// cleanup takes the socket off its documents: its awareness clients are
// removed and the rooms told.
func (s *socket) cleanup() {
	s.mu.Lock()
	sessions := s.sessions
	s.sessions = map[string]*sessionState{}
	s.mu.Unlock()
	for documentName, session := range sessions {
		doc := session.document
		if doc == nil {
			continue
		}
		if len(session.awarenessClients) > 0 {
			clients := make([]uint64, 0, len(session.awarenessClients))
			for client := range session.awarenessClients {
				doc.awareness.RemoveState(client)
				clients = append(clients, client)
			}
			doc.broadcast(encodeMessage(documentName, msgAwareness, appendBuf(nil, doc.awareness.Encode(clients))), nil)
		}
		s.app.WS.detachDocument(documentName, s.id, doc)
	}
}
