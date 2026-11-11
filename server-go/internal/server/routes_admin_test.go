package server

import (
	"strings"
	"testing"
	"time"

	"github.com/Deln0r/ygo"
)

func TestSearchPattern(t *testing.T) {
	if got := searchPattern(nil); got != "%%" {
		t.Fatalf("nil: %q", got)
	}
	if got := searchPattern(ptr(`  50%_a\b `)); got != `%50\%\_a\\b%` {
		t.Fatalf("escaped: %q", got)
	}
	if got := searchPattern(ptr(strings.Repeat("王", 300))); got != "%"+strings.Repeat("王", 200)+"%" {
		t.Fatalf("long: %d characters", len([]rune(got)))
	}
}

func TestAdminListQueryPagination(t *testing.T) {
	limit, offset, block := (&AdminListQuery{}).pagination(0)
	if limit != 25 || offset != 0 || block["page"] != int64(1) || block["totalPages"] != int64(0) ||
		block["hasNext"] != false || block["hasPrev"] != false {
		t.Fatalf("empty: %d %d %v", limit, offset, block)
	}
	limit, offset, block = (&AdminListQuery{Page: ptr(uint32(9)), PageSize: ptr(uint32(1000))}).pagination(250)
	if limit != 100 || offset != 200 || block["page"] != int64(3) || block["totalPages"] != int64(3) ||
		block["hasNext"] != false || block["hasPrev"] != true {
		t.Fatalf("clamped: %d %d %v", limit, offset, block)
	}
	limit, offset, _ = (&AdminListQuery{Page: ptr(uint32(0)), PageSize: ptr(uint32(0))}).pagination(5)
	if limit != 1 || offset != 0 {
		t.Fatalf("zero: %d %d", limit, offset)
	}
}

func TestMergeBucketUserID(t *testing.T) {
	a, b := "a", "b"
	rows := func(ids ...*string) []PlaybackUpdateRow {
		out := []PlaybackUpdateRow{}
		for _, id := range ids {
			out = append(out, PlaybackUpdateRow{UserID: id})
		}
		return out
	}
	if got := mergeBucketUserID(rows(nil, nil)); got != nil {
		t.Fatal("none")
	}
	if got := mergeBucketUserID(rows(nil, &a, &a)); got == nil || *got != "a" {
		t.Fatal("one user after an anonymous update")
	}
	if got := mergeBucketUserID(rows(&a, &b)); got != nil {
		t.Fatal("two users")
	}
	// As in the Rust: an anonymous update after a named one is a mismatch.
	if got := mergeBucketUserID(rows(&a, nil)); got != nil {
		t.Fatal("anonymous after named")
	}
}

// textUpdates makes a document's updates, one for each insert.
func textUpdates(t *testing.T, parts ...string) (updates [][]byte, text string) {
	t.Helper()
	doc := ygo.NewDoc()
	content := ygo.NewText(doc, "codemirror")
	before := ygo.EncodeStateVector(doc)
	for _, part := range parts {
		txn := doc.WriteTxn()
		if err := content.Insert(txn, uint64(len(text)), part); err != nil {
			t.Fatal(err)
		}
		txn.Commit()
		text += part
		update, err := ygo.EncodeDiff(doc, before)
		if err != nil {
			t.Fatal(err)
		}
		updates = append(updates, update)
		before = ygo.EncodeStateVector(doc)
	}
	return updates, text
}

func TestCompressPlaybackBuckets(t *testing.T) {
	updates, text := textUpdates(t, "ab", "cd", "ef", "gh")
	start := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	user := "u1"
	rows := []PlaybackUpdateRow{
		{Update: updates[0], Timestamp: start.Add(100 * time.Millisecond), UserID: &user},
		{Update: updates[1], Timestamp: start.Add(900 * time.Millisecond), UserID: &user},
		{Update: updates[2], Timestamp: start.Add(1500 * time.Millisecond)},
		{Update: updates[3], Timestamp: start.Add(1700 * time.Millisecond)},
	}
	buckets, err := compressPlaybackBuckets(rows)
	if err != nil {
		t.Fatal(err)
	}
	// One bucket for each second that has updates, at that second.
	if len(buckets) != 2 {
		t.Fatalf("buckets: %d", len(buckets))
	}
	if !buckets[0].Timestamp.Equal(start) || !buckets[1].Timestamp.Equal(start.Add(time.Second)) {
		t.Fatalf("buckets at %s and %s", buckets[0].Timestamp, buckets[1].Timestamp)
	}
	if buckets[0].UserID == nil || *buckets[0].UserID != "u1" || buckets[1].UserID != nil {
		t.Fatal("user IDs")
	}
	doc := ygo.NewDoc()
	content := ygo.NewText(doc, "codemirror")
	for _, bucket := range buckets {
		if err := ygo.ApplyUpdate(doc, bucket.Update); err != nil {
			t.Fatal(err)
		}
	}
	if got := content.String(); got != text {
		t.Fatalf("replayed %q, want %q", got, text)
	}

	if buckets, err := compressPlaybackBuckets(nil); err != nil || len(buckets) != 0 {
		t.Fatal("no updates")
	}
	if _, err := mergeBucketUpdates([]PlaybackUpdateRow{{Update: []byte{0xff}}, {Update: []byte{0xff}}}); err == nil {
		t.Fatal("updates that do not decode must fail")
	}
}
