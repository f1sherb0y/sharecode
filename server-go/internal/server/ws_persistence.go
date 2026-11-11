package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/Deln0r/ygo"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Each room has one independent durable writer (ws/persistence.rs). Live
// updates are broadcast immediately; acknowledgements and barriers follow a
// committed log prefix.

const (
	maxPendingUpdates = 2048
	maxPendingBytes   = 8 * 1024 * 1024
	batchWindow       = 20 * time.Millisecond
	snapshotInterval  = 5 * time.Second
)

// pendingUpdate is one thing the writer does in order: store an edit, or
// answer a durability barrier.
type pendingUpdate struct {
	id         string
	update     []byte // nil for a barrier
	actor      *string
	connection ConnectionID
	timestamp  time.Time
	outgoing   *Outbound
	barrier    *string
}

func pendingEdit(update []byte, actor *string, connection ConnectionID, outgoing *Outbound) pendingUpdate {
	return pendingUpdate{id: uuid.NewString(), update: update, actor: actor, connection: connection,
		timestamp: time.Now().UTC(), outgoing: outgoing}
}

func pendingBarrier(id string, connection ConnectionID, outgoing *Outbound) pendingUpdate {
	return pendingUpdate{id: uuid.NewString(), connection: connection, timestamp: time.Now().UTC(),
		outgoing: outgoing, barrier: &id}
}

// runWriter is the writer of one room. It ends when the room retires.
func runWriter(db *pgxpool.Pool, name string, live *DocumentState, durable *ygo.Doc, seq int64, rx chan pendingUpdate) {
	ctx := context.Background()
	lastSnapshot := time.Now()
	dirty := false
	idle := time.NewTimer(2 * time.Second)
	defer idle.Stop()
	for {
		idle.Reset(2 * time.Second)
		var first pendingUpdate
		select {
		case first = <-rx:
		case <-idle.C:
			if dirty && time.Since(lastSnapshot) >= snapshotInterval {
				if saveSnapshot(ctx, db, name, durable, seq) == nil {
					dirty = false
				}
				lastSnapshot = time.Now()
			}
			// There are no accepted updates in flight when the queue is
			// empty. A failed snapshot is safe: the committed log remains.
			if live.retireIfIdle() {
				return
			}
			continue
		}

		batch := []pendingUpdate{first}
		bytes := len(first.update)
		window := time.NewTimer(batchWindow)
	collect:
		for len(batch) < 128 && bytes < 256*1024 {
			select {
			case entry := <-rx:
				bytes += len(entry.update)
				batch = append(batch, entry)
			case <-window.C:
				break collect
			}
		}
		window.Stop()

		started := time.Now()
		retry := 100 * time.Millisecond
		var committed int64
		for {
			var err error
			if committed, err = commitBatch(ctx, db, name, batch); err == nil {
				break
			}
			slog.Error("room log commit failed; retrying retained batch", "room_id", name, "error", err, "pending_bytes", live.pendingBytes.Load())
			live.storageFailed.Store(true)
			live.sendPersistenceStatus(name, true)
			time.Sleep(retry)
			retry = min(retry*2, 3*time.Second)
		}
		seq = max(seq, committed)
		for _, entry := range batch {
			if entry.update == nil {
				continue
			}
			// Already validated by the live document. Only the durable
			// clone is used for checkpoints, never the live dirty state.
			if err := ygo.ApplyUpdate(durable, entry.update); err != nil {
				slog.Error("durable reconstruction failed", "room_id", name, "error", err)
				live.storageFailed.Store(true)
				return // no acknowledgements; log and client outbox survive
			}
			dirty = true
		}
		live.pendingBytes.Add(-int64(bytes))
		live.pendingCount.Add(-int64(len(batch)))
		live.durableSeq.Store(uint64(seq))
		live.storageFailed.Store(false)
		for _, entry := range batch {
			if !live.hasConnection(entry.connection) {
				continue
			}
			if entry.barrier != nil {
				ack, _ := json.Marshal(map[string]any{"type": "durability-ack", "id": *entry.barrier, "durableSeq": seq})
				entry.outgoing.send(encodeStatelessMessage(name, string(ack)))
			} else {
				entry.outgoing.send(encodeMessage(name, msgSyncStatus, []byte{1}))
			}
		}
		live.sendPersistenceStatus(name, false)
		slog.Debug("room log committed", "room_id", name, "updates", len(batch), "bytes", bytes, "elapsed_ms", time.Since(started).Milliseconds(), "seq", seq)
		if dirty && time.Since(lastSnapshot) >= snapshotInterval {
			if err := saveSnapshot(ctx, db, name, durable, seq); err != nil {
				slog.Warn("checkpoint failed; retaining log", "room_id", name, "error", err)
			} else {
				dirty = false
			}
			lastSnapshot = time.Now()
		}
	}
}

// commitBatch stores the edits of a batch as rows and returns the highest
// sequence number among them, 0 for a batch of barriers only.
func commitBatch(ctx context.Context, db *pgxpool.Pool, name string, batch []pendingUpdate) (int64, error) {
	var edits []pendingUpdate
	for _, entry := range batch {
		if entry.update != nil {
			edits = append(edits, entry)
		}
	}
	if len(edits) == 0 {
		return 0, nil
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '5s'"); err != nil {
		return 0, err
	}
	// A saved acknowledgement means WAL is durable even if a database
	// default was changed. This is not a claim of surviving loss of the
	// whole host.
	if _, err := tx.Exec(ctx, "SET LOCAL synchronous_commit = on"); err != nil {
		return 0, err
	}
	var query strings.Builder
	query.WriteString(`INSERT INTO "DocumentUpdate" (id,"documentId",update,"userId",timestamp,"connectionId") VALUES `)
	args := make([]any, 0, len(edits)*6)
	ids := make([]string, 0, len(edits))
	for i, entry := range edits {
		if i > 0 {
			query.WriteString(", ")
		}
		n := i * 6
		fmt.Fprintf(&query, "($%d, $%d, $%d, $%d, $%d, $%d)", n+1, n+2, n+3, n+4, n+5, n+6)
		args = append(args, entry.id, name, entry.update, entry.actor, entry.timestamp, strconv.FormatUint(entry.connection, 10))
		ids = append(ids, entry.id)
	}
	// Reusing event IDs makes a retry safe when the COMMIT response was lost.
	query.WriteString(" ON CONFLICT (id) DO NOTHING")
	if _, err := tx.Exec(ctx, query.String(), args...); err != nil {
		return 0, err
	}
	seq, err := scalar[int64](ctx, tx, `SELECT MAX(seq) FROM "DocumentUpdate" WHERE id = ANY($1)`, ids)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `UPDATE "Room" SET "updatedAt"=NOW() WHERE id=$1 AND NOT "isEnded" AND NOT "isDeleted"`, name); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return seq, nil
}

// saveSnapshot stores the checkpoint of a room: the whole durable document
// and the sequence number it covers.
func saveSnapshot(ctx context.Context, db *pgxpool.Pool, name string, doc *ygo.Doc, seq int64) error {
	// Missing dependencies must stay in the replay tail, not get skipped by
	// a checkpoint that cannot represent them.
	if ygo.HasPending(doc) {
		return nil
	}
	state := ygo.EncodeStateAsUpdate(doc)
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err := tx.Exec(ctx, "SET LOCAL statement_timeout = '5s'"); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO "Document" (id,name,data,"checkpointSeq","updatedAt") VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (name) DO UPDATE SET data=EXCLUDED.data, "checkpointSeq"=EXCLUDED."checkpointSeq", "updatedAt"=NOW()
        WHERE "Document"."checkpointSeq" <= EXCLUDED."checkpointSeq"`, uuid.NewString(), name, state, seq); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
