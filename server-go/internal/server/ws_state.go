package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Deln0r/ygo"
)

// The collaboration side of the server (ws/state.rs): the documents that
// are open and the connections on them.

// ConnectionID identifies one socket.
type ConnectionID = uint64

// docSlot holds one room's document while it is open. Its lock serializes
// loading: only that room waits, the registry lock never spans I/O.
type docSlot struct {
	mu  sync.Mutex
	doc *DocumentState
}

// WsState is the registry of open documents.
type WsState struct {
	app *App

	documentsMu sync.RWMutex
	documents   map[string]*docSlot

	nextConnectionID atomic.Uint64

	// access serializes authorization changes with authentication and
	// incoming frames: every frame is handled under the read lock; routes
	// that change who may do what hold the write lock around the database
	// change and the revocation that follows.
	access sync.RWMutex
}

func newWsState(app *App) *WsState {
	return &WsState{app: app, documents: map[string]*docSlot{}}
}

func (s *WsState) newConnectionID() ConnectionID { return s.nextConnectionID.Add(1) }

func (s *WsState) slots() map[string]*docSlot {
	s.documentsMu.RLock()
	defer s.documentsMu.RUnlock()
	out := make(map[string]*docSlot, len(s.documents))
	for name, slot := range s.documents {
		out[name] = slot
	}
	return out
}

func (s *WsState) getDocument(name string) *DocumentState {
	s.documentsMu.RLock()
	slot := s.documents[name]
	s.documentsMu.RUnlock()
	if slot == nil {
		return nil
	}
	slot.mu.Lock()
	defer slot.mu.Unlock()
	return slot.doc
}

// attachDocument adds a connection to a room's document, loading the
// document first when nobody has it open.
func (s *WsState) attachDocument(ctx context.Context, name string, id ConnectionID, sender *Outbound,
	actorID, shareLinkID, loginSessionID *string, username string) (*DocumentState, SessionColor, error) {
	s.documentsMu.Lock()
	slot := s.documents[name]
	if slot == nil {
		slot = &docSlot{}
		s.documents[name] = slot
	}
	s.documentsMu.Unlock()

	slot.mu.Lock()
	defer slot.mu.Unlock()
	if slot.doc == nil {
		persistence := make(chan pendingUpdate, maxPendingUpdates)
		loaded, durable, seq, err := loadDocumentState(ctx, s.app.DB, name, persistence)
		if err != nil {
			return nil, SessionColor{}, err
		}
		loaded.slot = slot
		go runWriter(s.app.DB, name, loaded, durable, seq, persistence)
		slot.doc = loaded
	}
	doc := slot.doc
	return doc, doc.addConnection(id, sender, actorID, shareLinkID, loginSessionID, username), nil
}

func (s *WsState) detachDocument(name string, id ConnectionID, doc *DocumentState) {
	doc.removeConnection(id)
	doc.broadcastPresence(name)
	// The writer retires the room after the last accepted update is
	// durable. It uses the same slot lock as registration, and a grace
	// period.
}

// BroadcastRoomLanguage tells a room its language changed.
func (s *WsState) BroadcastRoomLanguage(room, language string) {
	if doc := s.getDocument(room); doc != nil {
		doc.broadcast(statelessJSON(room, map[string]any{"type": "room-language", "language": language}), nil)
	}
}

// OccupiedRooms lists the rooms somebody is connected to.
func (s *WsState) OccupiedRooms() []string {
	rooms := []string{}
	for name, slot := range s.slots() {
		slot.mu.Lock()
		doc := slot.doc
		slot.mu.Unlock()
		if doc != nil && doc.connectionCount() > 0 {
			rooms = append(rooms, name)
		}
	}
	return rooms
}

// WaitForSaved returns once every update accepted for the room is stored,
// or 503 after five seconds.
func (s *WsState) WaitForSaved(ctx context.Context, room string) error {
	doc := s.getDocument(room)
	if doc == nil {
		return nil
	}
	deadline := time.Now().Add(5 * time.Second)
	for doc.pendingCount.Load() != 0 {
		if time.Now().After(deadline) {
			return serviceUnavailable("Room history is still saving; retry shortly")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(20 * time.Millisecond):
		}
	}
	return nil
}

// The revocations: the caller holds access for writing until the database
// change and the revocation finish.

// RevokeShare closes the connections of a room that came through a share
// link.
func (s *WsState) RevokeShare(room, share string) {
	if doc := s.getDocument(room); doc != nil {
		doc.revoke(room, func(c *documentConnection) bool { return c.shareLinkID != nil && *c.shareLinkID == share })
	}
}

func (s *WsState) revokeEverywhere(matches func(*documentConnection) bool) {
	for name, slot := range s.slots() {
		slot.mu.Lock()
		doc := slot.doc
		slot.mu.Unlock()
		if doc != nil {
			doc.revoke(name, matches)
		}
	}
}

// RevokeActor closes every connection of an account or guest.
func (s *WsState) RevokeActor(actor string) {
	s.revokeEverywhere(func(c *documentConnection) bool { return c.actorID != nil && *c.actorID == actor })
}

// RevokeSession closes every connection of a browser session.
func (s *WsState) RevokeSession(session string) {
	s.revokeEverywhere(func(c *documentConnection) bool { return c.loginSessionID != nil && *c.loginSessionID == session })
}

// RevokeRoomActor closes an actor's connections to one room.
func (s *WsState) RevokeRoomActor(room, actor string) {
	if doc := s.getDocument(room); doc != nil {
		doc.revoke(room, func(c *documentConnection) bool { return c.actorID != nil && *c.actorID == actor })
	}
}

// RevokeRoom closes every connection to a room.
func (s *WsState) RevokeRoom(room string) {
	if doc := s.getDocument(room); doc != nil {
		doc.markEnded()
		doc.revoke(room, func(*documentConnection) bool { return true })
	}
}

// RevokeInaccessibleRoom rechecks the connections of a room when its
// lifecycle, pinning or owner rank changes, and closes those whose actor may
// no longer see it. Explicit guest invitations remain valid until the room
// ends or is deleted.
func (s *WsState) RevokeInaccessibleRoom(ctx context.Context, room string) {
	doc := s.getDocument(room)
	if doc == nil {
		return
	}
	actors := doc.actors()
	allowed, err := scalars[string](ctx, s.app.DB, `
        SELECT u.id FROM "User" u CROSS JOIN "Room" r
        JOIN "User" o ON o.id = r."ownerId"
        WHERE r.id = $1 AND u.id = ANY($2) AND NOT u."isDeleted"
          AND room_is_visible(u.id, u.role, room_role_rank(u.role) > 0,
            r."ownerId", o.role, r."isPrivate", r."isPinned", r."isEnded", r."isDeleted",
            EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = u.id),
            EXISTS(SELECT 1 FROM "RoomParticipant" p WHERE p."roomId" = r.id AND p."userId" = u.id AND p."canReplay"))
        UNION ALL
        SELECT g.id FROM "GuestSession" g JOIN "Room" r ON r.id = g."roomId"
        JOIN "RoomShareLink" l ON l.id = g."shareLinkId"
        WHERE r.id = $1 AND g.id = ANY($2) AND NOT r."isDeleted" AND NOT r."isEnded"`, room, actors)
	if err != nil {
		slog.Error("Failed to revalidate room connections; closing access", "error", err, "room", room)
		doc.revoke(room, func(*documentConnection) bool { return true })
		return
	}
	doc.revoke(room, func(c *documentConnection) bool {
		return !(c.actorID != nil && slices.Contains(allowed, *c.actorID))
	})
}

// broadcastRoomEnded tells a room it has ended, stops its writes and closes
// the connections that may no longer see it.
func (a *App) broadcastRoomEnded(ctx context.Context, roomID string, endedAt time.Time) {
	doc := a.WS.getDocument(roomID)
	if doc == nil {
		return
	}
	doc.markEnded()
	doc.broadcast(statelessJSON(roomID, map[string]any{"type": "room-status", "status": "ended", "endedAt": isoString(endedAt)}), nil)
	a.WS.RevokeInaccessibleRoom(ctx, roomID)
}

func statelessJSON(documentName string, value any) []byte {
	raw, _ := json.Marshal(value)
	return encodeStatelessMessage(documentName, string(raw))
}

// documentConnection is one socket's part in a room.
type documentConnection struct {
	sender         *Outbound
	color          SessionColor
	actorID        *string
	shareLinkID    *string
	loginSessionID *string
	username       string
	clientID       *uint64
}

// DocumentState is one open room: the live document, who is connected, and
// the queue to the writer that stores its updates.
type DocumentState struct {
	doc       *ygo.Doc
	awareness *ygo.Awareness

	connectionsMu sync.RWMutex
	connections   map[ConnectionID]*documentConnection

	// updateLock orders the edits of the room: applying an update and
	// queueing it for the writer are one step.
	updateLock  sync.Mutex
	persistence chan pendingUpdate

	pendingBytes  atomic.Int64
	pendingCount  atomic.Int64
	durableSeq    atomic.Uint64
	storageFailed atomic.Bool
	isEnded       atomic.Bool

	slot *docSlot
}

// loadDocumentState reads a room's document: the checkpoint and the updates
// after it. durable is an independent copy for the writer, which makes the
// checkpoints from what is stored and never from the live document.
func loadDocumentState(ctx context.Context, db DBTX, name string, persistence chan pendingUpdate) (state *DocumentState, durable *ygo.Doc, seq int64, err error) {
	type snapshotRow struct {
		Data          []byte `db:"data"`
		CheckpointSeq int64  `db:"checkpoint_seq"`
	}
	row, err := queryOptional[snapshotRow](ctx, db, `SELECT data, "checkpointSeq" as checkpoint_seq FROM "Document" WHERE name = $1`, name)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("db error: %w", err)
	}
	doc := ygo.NewDoc()
	var checkpoint int64
	if row != nil {
		checkpoint = row.CheckpointSeq
		if row.Data != nil {
			if err := ygo.ApplyUpdate(doc, row.Data); err != nil {
				return nil, nil, 0, fmt.Errorf("decode error: %w", err)
			}
		}
	}
	seq = checkpoint

	// Recover historical snapshot gaps and updates whose dependencies
	// arrived later. CRDT updates are idempotent; replaying
	// snapshot-covered entries is safe, including old batched histories.
	type updateRow struct {
		Seq    int64  `db:"seq"`
		Update []byte `db:"update"`
	}
	updates, err := queryAll[updateRow](ctx, db, `SELECT seq, update FROM "DocumentUpdate" WHERE "documentId" = $1 AND seq > $2 ORDER BY seq`, name, checkpoint)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("db error: %w", err)
	}
	durable = ygo.NewDoc()
	if err := ygo.ApplyUpdate(durable, ygo.EncodeStateAsUpdate(doc)); err != nil {
		return nil, nil, 0, fmt.Errorf("apply error: %w", err)
	}
	for _, update := range updates {
		if err := ygo.ApplyUpdate(doc, update.Update); err != nil {
			return nil, nil, 0, fmt.Errorf("apply error: %w", err)
		}
		if err := ygo.ApplyUpdate(durable, update.Update); err != nil {
			return nil, nil, 0, fmt.Errorf("apply error: %w", err)
		}
		seq = update.Seq
	}

	ended, err := scalarOptional[bool](ctx, db, `SELECT "isEnded" FROM "Room" WHERE id = $1`, name)
	if err != nil {
		return nil, nil, 0, fmt.Errorf("db error: %w", err)
	}
	state = &DocumentState{
		doc:         doc,
		awareness:   ygo.NewAwareness(doc.ClientID()),
		connections: map[ConnectionID]*documentConnection{},
		persistence: persistence,
	}
	state.durableSeq.Store(uint64(seq))
	state.isEnded.Store(ended != nil && *ended)
	return state, durable, seq, nil
}

func (d *DocumentState) markEnded() { d.isEnded.Store(true) }

func (d *DocumentState) connectionCount() int {
	d.connectionsMu.RLock()
	defer d.connectionsMu.RUnlock()
	return len(d.connections)
}

func (d *DocumentState) actors() []string {
	d.connectionsMu.RLock()
	defer d.connectionsMu.RUnlock()
	out := []string{}
	for _, c := range d.connections {
		if c.actorID != nil {
			out = append(out, *c.actorID)
		}
	}
	return out
}

func (d *DocumentState) addConnection(id ConnectionID, sender *Outbound, actorID, shareLinkID, loginSessionID *string, username string) SessionColor {
	d.connectionsMu.Lock()
	defer d.connectionsMu.Unlock()
	if existing := d.connections[id]; existing != nil {
		return existing.color
	}
	used := make([]int, 0, len(d.connections))
	for _, c := range d.connections {
		used = append(used, c.color.Slot)
	}
	color := sessionColorForSlot(nextAvailableColorSlot(used))
	d.connections[id] = &documentConnection{sender: sender, color: color, actorID: actorID,
		shareLinkID: shareLinkID, loginSessionID: loginSessionID, username: username}
	return color
}

func (d *DocumentState) removeConnection(id ConnectionID) {
	d.connectionsMu.Lock()
	delete(d.connections, id)
	d.connectionsMu.Unlock()
}

// retireIfIdle closes the room when nothing is waiting to be stored and
// nobody is connected. The writer calls it; true ends the writer.
func (d *DocumentState) retireIfIdle() bool {
	slot := d.slot
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if d.pendingCount.Load() == 0 && d.connectionCount() == 0 {
		if slot.doc == d {
			slot.doc = nil
		}
		return true
	}
	return false
}

func (d *DocumentState) sendPersistenceStatus(name string, failed bool) {
	d.broadcast(statelessJSON(name, map[string]any{
		"type": "persistence-status", "pending": d.pendingCount.Load(),
		"failed": failed || d.storageFailed.Load(), "durableSeq": d.durableSeq.Load(), "protocol": 1,
	}), nil)
}

// registerPresence records which Yjs client a connection is, unless another
// connection claims that client already.
func (d *DocumentState) registerPresence(name string, connection ConnectionID, clientID uint64) {
	d.connectionsMu.Lock()
	for id, c := range d.connections {
		if id != connection && c.clientID != nil && *c.clientID == clientID {
			d.connectionsMu.Unlock()
			return
		}
	}
	if c := d.connections[connection]; c != nil {
		c.clientID = &clientID
	}
	d.connectionsMu.Unlock()
	d.broadcastPresence(name)
}

func (d *DocumentState) presenceMessage(name string) []byte {
	d.connectionsMu.RLock()
	members := make([]map[string]any, 0, len(d.connections))
	for id, c := range d.connections {
		clientID := id
		if c.clientID != nil {
			clientID = *c.clientID
		}
		members = append(members, map[string]any{
			"connectionId": strconv.FormatUint(id, 10), "clientId": clientID,
			"id": c.actorID, "username": c.username, "colorSlot": c.color.Slot,
			"color": c.color.Color, "colorLight": c.color.ColorLight,
		})
	}
	d.connectionsMu.RUnlock()
	return statelessJSON(name, map[string]any{"type": "presence-state", "members": members})
}

func (d *DocumentState) broadcastPresence(name string) { d.broadcast(d.presenceMessage(name), nil) }

func (d *DocumentState) sendPresence(name string, outgoing *Outbound) {
	outgoing.send(d.presenceMessage(name))
}

func (d *DocumentState) connectionSender(id ConnectionID) *Outbound {
	d.connectionsMu.RLock()
	defer d.connectionsMu.RUnlock()
	if c := d.connections[id]; c != nil {
		return c.sender
	}
	return nil
}

func (d *DocumentState) hasConnection(id ConnectionID) bool {
	d.connectionsMu.RLock()
	defer d.connectionsMu.RUnlock()
	return d.connections[id] != nil
}

func (d *DocumentState) renewConnectionSession(id ConnectionID, sessionID *string) {
	d.connectionsMu.Lock()
	if c := d.connections[id]; c != nil {
		c.loginSessionID = sessionID
	}
	d.connectionsMu.Unlock()
}

// revoke removes the matching connections: each is told, then closed with
// "Access revoked".
func (d *DocumentState) revoke(name string, matches func(*documentConnection) bool) {
	d.connectionsMu.Lock()
	for id, c := range d.connections {
		if !matches(c) {
			continue
		}
		c.sender.send(encodeStatelessMessage(name, `{"type":"access-revoked"}`))
		c.sender.close("Access revoked")
		delete(d.connections, id)
	}
	d.connectionsMu.Unlock()
	d.broadcastPresence(name)
}

// broadcast sends a message to every connection of the room, except one if
// given.
func (d *DocumentState) broadcast(message []byte, exclude *ConnectionID) {
	d.connectionsMu.RLock()
	defer d.connectionsMu.RUnlock()
	for id, c := range d.connections {
		if exclude != nil && *exclude == id {
			continue
		}
		c.sender.send(message)
	}
}
