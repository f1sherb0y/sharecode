// sign-update writes <file>.sig, the base64 minisign signature the update feed
// carries, with the key in TAURI_SIGNING_PRIVATE_KEY. It refuses a key that is
// not the one installed clients trust.
package main

import (
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"aead.dev/minisign"
	"sharecode/client/internal/updates"
)

func decodeKey(value string) ([]byte, error) {
	if strings.HasPrefix(strings.TrimSpace(value), "untrusted comment:") {
		return []byte(value), nil
	}
	return base64.StdEncoding.DecodeString(strings.TrimSpace(value))
}
func sign(reader io.Reader, encodedKey, password, encodedPublic string) ([]byte, error) {
	raw, err := decodeKey(encodedKey)
	if err != nil {
		return nil, errors.New("Invalid signing-key encoding")
	}
	var private minisign.PrivateKey
	if minisign.IsEncrypted(raw) {
		private, err = minisign.DecryptKey(password, raw)
	} else {
		err = private.UnmarshalText(raw)
	}
	if err != nil {
		return nil, errors.New("Unable to unlock the existing signing identity")
	}
	publicText, err := base64.StdEncoding.DecodeString(encodedPublic)
	if err != nil {
		return nil, err
	}
	var public minisign.PublicKey
	if err = public.UnmarshalText(publicText); err != nil {
		return nil, err
	}
	if !public.Equal(private.Public()) {
		return nil, errors.New("Signing key does not match the installed client's pinned updater key")
	}
	stream := minisign.NewReader(reader)
	if _, err = io.Copy(io.Discard, stream); err != nil {
		return nil, err
	}
	signature := stream.Sign(private)
	if !stream.Verify(public, signature) {
		return nil, errors.New("Generated signature failed local verification")
	}
	return []byte(base64.StdEncoding.EncodeToString(signature) + "\n"), nil
}
func run() error {
	file := flag.String("file", "", "installer to sign")
	flag.Parse()
	if *file == "" {
		return errors.New("-file is required")
	}
	// Like the Tauri CLI, the variable holds the key or the path of its file.
	key := os.Getenv("TAURI_SIGNING_PRIVATE_KEY")
	if key == "" {
		return errors.New("TAURI_SIGNING_PRIVATE_KEY is required")
	}
	if raw, err := os.ReadFile(key); err == nil {
		key = string(raw)
	}
	input, err := os.Open(*file)
	if err != nil {
		return err
	}
	defer input.Close()
	signature, err := sign(input, key, os.Getenv("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"), updates.PublicKey)
	if err != nil {
		return err
	}
	return os.WriteFile(*file+".sig", signature, 0o644)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
