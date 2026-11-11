package server

import (
	"strings"
	"testing"
)

func TestCodesAreUnambiguousAndAcceptTheDisplayForm(t *testing.T) {
	code := generateCode()
	if len(code) != codeLength {
		t.Fatalf("code length = %d, want %d", len(code), codeLength)
	}
	for _, b := range []byte(code) {
		if !strings.ContainsRune(codeAlphabet, rune(b)) {
			t.Fatalf("code %q has %q, which is outside the alphabet", code, b)
		}
	}
	if generateCode() == code {
		t.Fatal("two generated codes are equal")
	}
	if got := normalizeCode(" abcd-efgh jk2m\n"); got != "ABCDEFGHJK2M" {
		t.Fatalf("normalizeCode = %q", got)
	}
	if got := normalizeCode("--"); got != "" {
		t.Fatalf("normalizeCode(\"--\") = %q", got)
	}
}
