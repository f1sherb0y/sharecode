package main

import (
	"bytes"
	"encoding/base64"
	"io"
	"strings"
	"testing"

	"aead.dev/minisign"
)

func TestSignatureUsesExistingKeyAndTauriEnvelope(t *testing.T) {
	public, private, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	publicText, _ := public.MarshalText()
	privateText, _ := private.MarshalText()
	data := []byte("isolated Windows installer fixture")
	encodedPublic := base64.StdEncoding.EncodeToString(publicText)
	for _, encoded := range []string{string(privateText), base64.StdEncoding.EncodeToString(privateText)} {
		out, err := sign(bytes.NewReader(data), encoded, "", encodedPublic)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(out)))
		if err != nil {
			t.Fatal(err)
		}
		reader := minisign.NewReader(bytes.NewReader(data))
		io.Copy(io.Discard, reader)
		if !reader.Verify(public, sig) {
			t.Fatal("Tauri-envelope signature did not verify")
		}
	}
	other, _, _ := minisign.GenerateKey(nil)
	otherText, _ := other.MarshalText()
	if _, err = sign(bytes.NewReader(data), string(privateText), "", base64.StdEncoding.EncodeToString(otherText)); err == nil {
		t.Fatal("accepted a replacement signing identity")
	}
}
func TestEncryptedSigningIdentity(t *testing.T) {
	public, private, err := minisign.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	publicText, _ := public.MarshalText()
	encrypted, err := minisign.EncryptKey("fixture-password", private)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(encrypted)
	pub := base64.StdEncoding.EncodeToString(publicText)
	if _, err = sign(strings.NewReader("fixture"), encoded, "wrong", pub); err == nil {
		t.Fatal("accepted incorrect password")
	}
	if _, err = sign(strings.NewReader("fixture"), encoded, "fixture-password", pub); err != nil {
		t.Fatal(err)
	}
}
