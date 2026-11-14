//go:build windows

package main

import (
	"strings"
	"testing"
)

func TestWithTrustInfo(t *testing.T) {
	manifest := "<assembly xmlns=\"urn:schemas-microsoft-com:asm.v1\">\n  <assemblyIdentity name=\"x\"/>\n</assembly>\n"
	out, err := withTrustInfo([]byte(manifest))
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	if !strings.Contains(got, `level="requireAdministrator"`) || !strings.HasSuffix(got, "</trustInfo>\n</assembly>\n") || !strings.HasPrefix(got, manifest[:strings.Index(manifest, "</assembly>")]) {
		t.Fatalf("unexpected manifest:\n%s", got)
	}
	if _, err = withTrustInfo(out); err == nil {
		t.Fatal("a manifest with an execution level was changed again")
	}
	if _, err = withTrustInfo([]byte("<assembly>")); err == nil {
		t.Fatal("a manifest without an end was accepted")
	}
}
