package server

import (
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"
)

// The unit tests of server-rs's core, utils and ws modules.

func TestPersistentCookieIsHTTPOnlySecureHostScopedAndExpiring(t *testing.T) {
	config := &Config{AppURL: ptr("https://collabcode.cc")}
	cookie := cookieHeader(config, "test-secret")
	for _, want := range []string{"__Host-sharecode-session=test-secret", "HttpOnly", "Secure", "Path=/", "SameSite=Lax", "Max-Age=2592000"} {
		if !strings.Contains(cookie, want) {
			t.Errorf("cookie %q lacks %q", cookie, want)
		}
	}
	if strings.Contains(cookie, "Domain") {
		t.Errorf("cookie %q has a domain", cookie)
	}
	if !strings.Contains(cookieHeader(config, ""), "Max-Age=0") {
		t.Error("an empty secret does not clear the cookie")
	}
}

func TestCookieCSRFRequiresExactTrustedOriginAndNonSimpleHeader(t *testing.T) {
	config := &Config{AppURL: ptr("https://collabcode.cc")}
	headers := http.Header{}
	if checkCookieRequest(config, headers) == nil {
		t.Error("a request without the client header passed")
	}
	headers.Set("X-Sharecode-Client", "web")
	headers.Set("Origin", "https://collabcode.cc")
	if err := checkCookieRequest(config, headers); err != nil {
		t.Error(err)
	}
	for _, origin := range []string{"null", "https://collabcode.cc.evil.invalid", "https://evil.invalid", "http://collabcode.cc"} {
		headers.Set("Origin", origin)
		if checkCookieRequest(config, headers) == nil {
			t.Errorf("origin %q passed", origin)
		}
	}
	config.AllowedOrigins = []string{"https://kode666.com", "https://64.186.229.171/"}
	for _, origin := range []string{"https://kode666.com", "https://64.186.229.171", "https://collabcode.cc"} {
		headers.Set("Origin", origin)
		if err := checkCookieRequest(config, headers); err != nil {
			t.Errorf("origin %q: %v", origin, err)
		}
	}
	for _, origin := range []string{"http://kode666.com", "https://www.kode666.com", "https://64.186.229.171:8443", "https://kode666.com.evil.invalid"} {
		headers.Set("Origin", origin)
		if checkCookieRequest(config, headers) == nil {
			t.Errorf("origin %q passed", origin)
		}
	}
	config.AppURL = ptr("http://127.0.0.1:5173")
	if secureCookie(config) {
		t.Error("loopback HTTP development needs an insecure cookie")
	}
	config.AppURL = ptr("http://example.com")
	if !secureCookie(config) {
		t.Error("an HTTP site that is not loopback must still get a secure cookie")
	}
}

func TestCookieSecretIsExactlyOneWellFormedCookie(t *testing.T) {
	config := &Config{AppURL: ptr("http://127.0.0.1:5173")}
	secret := strings.Repeat("a", 43)
	header := http.Header{"Cookie": {"other=1; sharecode-session=" + secret}}
	if got := cookieSecret(config, header); got == nil || *got != secret {
		t.Errorf("secret %v", got)
	}
	for _, bad := range []string{"sharecode-session=short", "sharecode-session=" + secret + "; sharecode-session=" + secret,
		"sharecode-session=" + strings.Repeat("!", 43)} {
		if got := cookieSecret(config, http.Header{"Cookie": {bad}}); got != nil {
			t.Errorf("%q gave a secret", bad)
		}
	}
}

func TestRolesRankAdminOverAgentOverTech(t *testing.T) {
	if !isAdmin(roleAdmin) || isAdmin(roleAgent) || isAdmin(roleTech) {
		t.Error("isAdmin")
	}
	if !isStaff(roleAdmin) || !isStaff(roleAgent) || isStaff(roleTech) {
		t.Error("isStaff")
	}
	// Retired role names grant nothing if an old value ever reappears.
	for _, retired := range []string{"superuser", "user", ""} {
		if isStaff(retired) || isAdmin(retired) {
			t.Errorf("retired role %q grants something", retired)
		}
	}
}

func TestContentEditsFollowOwnershipStaffOrLinkPermission(t *testing.T) {
	yes, no := ptr(true), ptr(false)
	// Ended rooms are read-only for everyone.
	if canEditRoomContent(true, true, true, yes) {
		t.Error("an ended room can be edited")
	}
	if !canEditRoomContent(false, true, false, nil) || !canEditRoomContent(false, false, true, no) {
		t.Error("owner or staff cannot edit")
	}
	// A tech's membership edits only if the last link joined through allows it.
	if !canEditRoomContent(false, false, false, yes) || canEditRoomContent(false, false, false, no) {
		t.Error("link permission is not followed")
	}
	// Pinned rooms grant visibility only.
	if canEditRoomContent(false, false, false, nil) {
		t.Error("visibility alone lets edit")
	}
}

func TestValidatesVersionedFingerprintHashOnly(t *testing.T) {
	if !validFingerprint("fp5:0123456789abcdef0123456789abcdef") {
		t.Error("a valid fingerprint was refused")
	}
	for _, invalid := range []string{"", "fp4:0123456789abcdef0123456789abcdef", "fp5:short", "fp5:0123456789abcdef0123456789abcdeg"} {
		if validFingerprint(invalid) {
			t.Errorf("%q was accepted", invalid)
		}
	}
}

func TestIgnoresForgedForwardingFromUntrustedPeers(t *testing.T) {
	h := http.Header{"X-Forwarded-For": {"1.2.3.4"}}
	if ip, _ := clientIP(netip.MustParseAddr("203.0.113.4"), h, nil); ip != netip.MustParseAddr("203.0.113.4") {
		t.Errorf("client IP %v", ip)
	}
}

func TestWalksOnlyTrustedSuffixHandlesIPv6AndInvalidHeaders(t *testing.T) {
	trusted := []string{"127.0.0.1/32", "10.0.0.0/24"}
	h := http.Header{"X-Forwarded-For": {"1.2.3.4, 2001:db8::7, 10.0.0.8"}}
	if ip, _ := clientIP(netip.MustParseAddr("127.0.0.1"), h, trusted); ip != netip.MustParseAddr("2001:db8::7") {
		t.Errorf("client IP %v", ip)
	}
	h.Set("X-Forwarded-For", "invalid")
	if _, source := clientIP(netip.MustParseAddr("127.0.0.1"), h, trusted); source != "socket-invalid-forwarded" {
		t.Errorf("source %q", source)
	}
}

func TestPasswordPolicy(t *testing.T) {
	if validatePassword("StrongPass123!") != "" {
		t.Error("a strong password was refused")
	}
	for _, bad := range []string{
		"Short1!Aa",                                                                    // short
		"alllowercase123!", "ALLUPPERCASE123!", "MissingDigits!!", "MissingSpecial123", // a category missing
		"Strong Pass123!",            // a space
		"Password1!", "ABCabc123!@#", // common
	} {
		if validatePassword(bad) == "" {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestUsernamesTrimAndRejectSpacesControlsAndLengths(t *testing.T) {
	if name, ok := normalizeUsername(" linfeikai "); !ok || name != "linfeikai" {
		t.Errorf("%q %v", name, ok)
	}
	if name, ok := normalizeUsername("王小明"); !ok || name != "王小明" {
		t.Errorf("%q %v", name, ok)
	}
	for _, bad := range []string{"", " a ", "two words", "tab\there", "bell\u0007", strings.Repeat("x", 33)} {
		if _, ok := normalizeUsername(bad); ok {
			t.Errorf("%q was accepted", bad)
		}
	}
}

func TestQueueOverflowClosesInsteadOfUnboundedGrowth(t *testing.T) {
	sender := newOutbound()
	for range maxOutboundFrames {
		if !sender.send([]byte{1}) {
			t.Fatal("the queue refused a frame it has room for")
		}
	}
	if sender.send([]byte{1}) {
		t.Error("the queue took a frame beyond its length")
	}
	if !sender.isClosed() {
		t.Error("overflow did not close the socket")
	}
}

func TestByteBudgetIsReleasedAfterDelivery(t *testing.T) {
	sender := newOutbound()
	if !sender.send(make([]byte, maxOutboundBytes)) {
		t.Fatal("a frame of the whole budget was refused")
	}
	sender.release(<-sender.frames)
	if !sender.send(make([]byte, maxOutboundBytes)) {
		t.Fatal("the budget was not released")
	}
	if sender.isClosed() {
		t.Error("closed")
	}
	sender.close("Access revoked")
	if reason := sender.reason.Load(); reason == nil || *reason != "Access revoked" {
		t.Error("the close reason was not kept")
	}
	if sender.send([]byte{1}) {
		t.Error("a closed socket took a frame")
	}
}

func TestTimestampsAreWrittenAsChronoWritesThem(t *testing.T) {
	whole := time.Date(2026, 11, 11, 6, 3, 0, 0, time.UTC)
	micro := time.Date(2026, 11, 11, 6, 3, 0, 123456000, time.UTC)
	milli := time.Date(2026, 11, 11, 6, 3, 0, 120000000, time.UTC)
	for _, c := range []struct {
		t    time.Time
		want string
	}{{whole, "2026-11-11T06:03:00+00:00"}, {micro, "2026-11-11T06:03:00.123456+00:00"}, {milli, "2026-11-11T06:03:00.120+00:00"}} {
		if got := isoString(c.t); got != c.want {
			t.Errorf("isoString: %q, want %q", got, c.want)
		}
	}
	if raw, _ := (Time{micro}).MarshalJSON(); string(raw) != `"2026-11-11T06:03:00.123456Z"` {
		t.Errorf("Time: %s", raw)
	}
}

func TestSessionColoursMatchTheRustFormula(t *testing.T) {
	first := sessionColorForSlot(0)
	if first.Color != "hsl(0, 78%, 52%)" || first.ColorLight != "hsla(0, 78%, 70%, 0.5)" {
		t.Errorf("slot 0: %+v", first)
	}
	if got := sessionColorForSlot(1).Color; got != "hsl(138, 78%, 52%)" {
		t.Errorf("slot 1: %s", got)
	}
	if slot := nextAvailableColorSlot([]int{0, 1, 3}); slot != 2 {
		t.Errorf("next slot %d", slot)
	}
}
