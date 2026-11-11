package server

import (
	"errors"
	"sync"
	"sync/atomic"
)

// The wire format of the collaboration socket (ws/protocol.rs): Hocuspocus
// frames, each starting with the document name.

const maxDocumentNameLen = 256

const (
	msgSync           = 0
	msgAwareness      = 1
	msgAuth           = 2
	msgQueryAwareness = 3
	msgStateless      = 5
	msgClose          = 7
	msgSyncStatus     = 8

	authToken            = 0
	authPermissionDenied = 1
	authAuthenticated    = 2

	syncStep1  = 0
	syncStep2  = 1
	syncUpdate = 2
)

var (
	errWsDecode              = errors.New("decode error: unexpected end of buffer")
	errWsDocumentNameTooLong = errors.New("document name too long")
	// errWsBackpressure closes a connection whose room cannot take more
	// unsaved edits, or which asks for too many documents.
	errWsBackpressure = errors.New("Persistence queue is full; edits remain unconfirmed")
)

// cursor reads lib0 values from a buffer.
type cursor struct {
	data []byte
	next int
}

func (c *cursor) hasContent() bool { return c.next < len(c.data) }

func (c *cursor) readVar() (uint64, error) {
	var value uint64
	for shift := uint(0); ; shift += 7 {
		if c.next >= len(c.data) || shift > 63 {
			return 0, errWsDecode
		}
		b := c.data[c.next]
		c.next++
		value |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return value, nil
		}
	}
}

func (c *cursor) readBuf() ([]byte, error) {
	n, err := c.readVar()
	if err != nil || n > uint64(len(c.data)-c.next) {
		return nil, errWsDecode
	}
	out := c.data[c.next : c.next+int(n)]
	c.next += int(n)
	return out, nil
}

func (c *cursor) readString() (string, error) {
	raw, err := c.readBuf()
	return string(raw), err
}

func appendVar(out []byte, value uint64) []byte {
	for value >= 0x80 {
		out = append(out, byte(value)|0x80)
		value >>= 7
	}
	return append(out, byte(value))
}

func appendBuf(out, buf []byte) []byte {
	return append(appendVar(out, uint64(len(buf))), buf...)
}

func decodeFrame(data []byte) (documentName string, messageType uint64, payload []byte, err error) {
	c := &cursor{data: data}
	if documentName, err = c.readString(); err != nil {
		return "", 0, nil, err
	}
	if len(documentName) > maxDocumentNameLen {
		return "", 0, nil, errWsDocumentNameTooLong
	}
	if messageType, err = c.readVar(); err != nil {
		return "", 0, nil, err
	}
	return documentName, messageType, data[c.next:], nil
}

func decodeAuth(payload []byte) (authType uint64, token *string, err error) {
	c := &cursor{data: payload}
	if authType, err = c.readVar(); err != nil {
		return 0, nil, err
	}
	if c.hasContent() {
		value, err := c.readString()
		if err != nil {
			return 0, nil, err
		}
		token = &value
	}
	return authType, token, nil
}

func decodeVarBytes(payload []byte) ([]byte, error) {
	return (&cursor{data: payload}).readBuf()
}

func encodeMessage(documentName string, messageType uint64, payload []byte) []byte {
	out := make([]byte, 0, len(documentName)+len(payload)+8)
	out = appendBuf(out, []byte(documentName))
	out = appendVar(out, messageType)
	return append(out, payload...)
}

func encodeAuthMessage(documentName string, authType uint64, payload *string) []byte {
	body := appendVar(nil, authType)
	if payload != nil {
		body = appendBuf(body, []byte(*payload))
	}
	return encodeMessage(documentName, msgAuth, body)
}

func encodeStatelessMessage(documentName, payload string) []byte {
	return encodeMessage(documentName, msgStateless, appendBuf(nil, []byte(payload)))
}

// encodeSyncMessage is a sync message of the given kind around buf (a state
// vector for step 1, an update for step 2 and update).
func encodeSyncMessage(documentName string, kind uint64, buf []byte) []byte {
	return encodeMessage(documentName, msgSync, appendBuf(appendVar(nil, kind), buf))
}

func encodeSyncUpdate(documentName string, update []byte) []byte {
	return encodeSyncMessage(documentName, syncUpdate, update)
}

// --- bounded delivery per socket (ws/transport.rs) ---
//
// A slow peer cannot accumulate unlimited memory or stall a room.
// Revocation bypasses the data queue.

const (
	maxOutboundBytes  = 8 * 1024 * 1024
	maxOutboundFrames = 256
)

type frameKind int

const (
	frameBinary frameKind = iota
	frameClose            // a close without a reason of the server's own
)

type outFrame struct {
	kind   frameKind
	data   []byte
	budget int64
}

// Outbound is the sending side of one socket.
type Outbound struct {
	frames chan outFrame
	used   atomic.Int64

	closeOnce sync.Once
	closed    chan struct{}
	reason    atomic.Pointer[string]
}

func newOutbound() *Outbound {
	return &Outbound{frames: make(chan outFrame, maxOutboundFrames), closed: make(chan struct{})}
}

func (o *Outbound) isClosed() bool { return o.reason.Load() != nil }

func (o *Outbound) push(frame outFrame) bool {
	if o.isClosed() {
		return false
	}
	frame.budget = int64(max(len(frame.data), 1))
	if frame.kind == frameClose {
		frame.budget = 128
	}
	if o.used.Add(frame.budget) <= maxOutboundBytes {
		select {
		case o.frames <- frame:
			return true
		default:
		}
	}
	o.used.Add(-frame.budget)
	o.close("Slow connection; reconnect to synchronize")
	return false
}

// send queues a binary message; false when the socket is closing or has
// fallen behind (which closes it).
func (o *Outbound) send(message []byte) bool {
	return o.push(outFrame{kind: frameBinary, data: message})
}

// sendClose queues an ordinary close of the socket.
func (o *Outbound) sendClose() bool { return o.push(outFrame{kind: frameClose}) }

// release gives back the budget of a frame that has been written or
// dropped.
func (o *Outbound) release(frame outFrame) { o.used.Add(-frame.budget) }

// close ends the socket with a reason, ahead of anything queued.
func (o *Outbound) close(reason string) {
	o.reason.Store(&reason)
	o.closeOnce.Do(func() { close(o.closed) })
}
