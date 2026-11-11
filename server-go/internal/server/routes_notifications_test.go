package server

import (
	"encoding/json"
	"testing"
	"time"
)

func TestMarkNotificationsReadPayload(t *testing.T) {
	var p MarkNotificationsReadPayload
	if err := json.Unmarshal([]byte(`{}`), &p); err != nil || len(p.IDs) != 0 {
		t.Fatalf("absent: %v %v", err, p.IDs)
	}
	if err := json.Unmarshal([]byte(`{"ids":["a","b"],"other":1}`), &p); err != nil || len(p.IDs) != 2 {
		t.Fatalf("list: %v %v", err, p.IDs)
	}
	for _, bad := range []string{`{"ids":null}`, `{"ids":"a"}`, `{"ids":[1]}`, `null`} {
		if err := json.Unmarshal([]byte(bad), &p); err == nil {
			t.Fatalf("%s must not decode", bad)
		}
	}
}

func TestNotificationToJSON(t *testing.T) {
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	body, err := json.Marshal(notificationToJSON(&NotificationWithReadRow{
		ID: "n", Title: "t", Content: "c", Severity: "normal", CreatedBy: "u", CreatedAt: created, CreatedByUsername: "admin",
	}))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"content":"c","createdAt":"2026-01-02T03:04:05+00:00","createdBy":{"id":"u","username":"admin"},"data":null,"id":"n","isRead":false,"kind":null,"readAt":null,"severity":"normal","title":"t"}`
	if string(body) != want {
		t.Fatalf("got %s", body)
	}
	kind := "schedule.assigned"
	read := created.Add(time.Minute)
	body, _ = json.Marshal(notificationToJSON(&NotificationWithReadRow{
		Kind: &kind, Data: json.RawMessage(`{"appointmentId":"x","n":12345678901234567890}`), CreatedAt: created, ReadAt: &read,
	}))
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["isRead"] != true || decoded["readAt"] != "2026-01-02T03:05:05+00:00" || decoded["kind"] != kind ||
		decoded["data"].(map[string]any)["appointmentId"] != "x" {
		t.Fatalf("got %s", body)
	}
}
