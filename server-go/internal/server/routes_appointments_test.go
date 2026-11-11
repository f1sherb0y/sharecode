package server

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestStartTimesNeedAnOffsetAndDropSeconds(t *testing.T) {
	start, err := parseStart(ptr("2026-10-20T14:30:45.5+08:00"))
	if err != nil {
		t.Fatal(err)
	}
	if got := isoString(start); got != "2026-10-20T06:30:00+00:00" {
		t.Errorf("start = %s", got)
	}
	for _, invalid := range []*string{nil, ptr(""), ptr("2026-10-20T14:30"), ptr("1999-12-31T00:00:00Z"), ptr("tomorrow")} {
		if _, err := parseStart(invalid); err == nil {
			if invalid == nil {
				t.Error("nil must be refused")
			} else {
				t.Errorf("%q must be refused", *invalid)
			}
		}
	}
}

func TestDurationsAreBounded(t *testing.T) {
	if _, err := checkDuration(4); err == nil {
		t.Error("4 minutes must be refused")
	}
	if _, err := checkDuration(1441); err == nil {
		t.Error("1441 minutes must be refused")
	}
	if got, err := checkDuration(5); err != nil || got != 5 {
		t.Errorf("5: %d %v", got, err)
	}
	if got, err := checkDuration(1440); err != nil || got != 1440 {
		t.Errorf("1440: %d %v", got, err)
	}
}

func TestRoomNamesAreCompanyAndPositionWithoutTheCustomer(t *testing.T) {
	if got := roomName(ptr("字节"), ptr("后端")); got != "字节 后端" {
		t.Errorf("both: %q", got)
	}
	if got := roomName(nil, ptr("后端")); got != "后端" {
		t.Errorf("position only: %q", got)
	}
	if got := roomName(ptr("字节"), nil); got != "字节" {
		t.Errorf("company only: %q", got)
	}
	if got := roomName(nil, nil); got != unnamedRoom {
		t.Errorf("neither: %q", got)
	}
	long := strings.Repeat("长", 200)
	if got := utf8.RuneCountInString(roomName(&long, nil)); got != maxRoomNameChars {
		t.Errorf("long name has %d characters", got)
	}
}

func TestOnlyUnfinishedSessionsAreAnnounced(t *testing.T) {
	notice := func(startsAt time.Time, duration int32) *Notice {
		return &Notice{appointmentID: "a", customerName: ptr("c"), startsAt: startsAt, duration: duration}
	}
	if !notice(time.Now().Add(time.Hour), 30).isAhead() {
		t.Error("a session to come is ahead")
	}
	// Already started but still running.
	if !notice(time.Now().Add(-10*time.Minute), 30).isAhead() {
		t.Error("a running session is ahead")
	}
	if notice(time.Now().Add(-2*time.Hour), 60).isAhead() {
		t.Error("a finished session is not ahead")
	}
}
