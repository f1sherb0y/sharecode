// Package updates reads the client update feed (/api/client/update, Tauri's
// dynamic update format) and verifies downloads against the client's minisign key.
package updates

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"aead.dev/minisign"
)

const PublicKey = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZFQzk4NDk1Mzg3RTQ1MUYKUldRZlJYNDRsWVRKL3JtQXFGMlc2YWZSL2M3eUpQQ0dCTm8vdDg4S1A0dGw5am9wN1U3NzNjNzEK"
const maxDownload = int64(2 << 30)

type Release struct {
	Version   string `json:"version"`
	Notes     string `json:"notes"`
	Date      string `json:"pub_date"`
	URL       string `json:"url"`
	Signature string `json:"signature"`
}
type Progress struct {
	Event string           `json:"event"`
	Data  map[string]int64 `json:"data,omitempty"`
}
type Client struct {
	HTTP           *http.Client
	Endpoints      []string
	PublicKey      string
	CurrentVersion string
	// AllowHTTP exists only for explicit loopback test fixtures, never production.
	AllowHTTP bool
}

func New(endpoints []string) *Client {
	return &Client{HTTP: &http.Client{Timeout: 5 * time.Minute, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("Update redirects require HTTPS")
		}
		if len(via) >= 10 {
			return errors.New("Too many update redirects")
		}
		return nil
	}}, Endpoints: endpoints, PublicKey: PublicKey}
}
func (c *Client) validURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.User != nil || u.Host == "" || (u.Scheme != "https" && !(c.AllowHTTP && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1"))) {
		return errors.New("Update URL requires HTTPS without credentials")
	}
	return nil
}

// Check accepts an explicit 204 or valid metadata not newer than CurrentVersion
// as current. Network/parse/version failures never unlock the application.
func (c *Client) Check(ctx context.Context) (*Release, error) {
	if c.CurrentVersion != "" {
		if _, err := parseVersion(c.CurrentVersion); err != nil {
			return nil, err
		}
	}
	var failures []error
	for _, endpoint := range c.Endpoints {
		release, err := c.checkOne(ctx, endpoint)
		if err == nil {
			return release, nil
		}
		failures = append(failures, err)
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
	if len(failures) == 0 {
		return nil, errors.New("No update endpoints configured")
	}
	return nil, errors.Join(failures...)
}
func (c *Client) checkOne(ctx context.Context, endpoint string) (*Release, error) {
	if err := c.validURL(endpoint); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNoContent {
		return nil, nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Update endpoint returned HTTP %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 1<<20 {
		return nil, errors.New("Update metadata is too large")
	}
	var release Release
	if err = json.Unmarshal(data, &release); err != nil {
		return nil, err
	}
	if strings.TrimSpace(release.Version) == "" || release.Signature == "" {
		return nil, errors.New("Incomplete update metadata")
	}
	if err = c.validURL(release.URL); err != nil {
		return nil, err
	}
	if _, err = decodeSignature(release.Signature); err != nil {
		return nil, err
	}
	if _, err = parseVersion(release.Version); err != nil {
		return nil, err
	}
	if c.CurrentVersion != "" {
		comparison, err := CompareVersions(release.Version, c.CurrentVersion)
		if err != nil {
			return nil, err
		}
		if comparison <= 0 {
			return nil, nil
		}
	}
	return &release, nil
}
func decodeSignature(encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("Invalid update signature encoding: %w", err)
	}
	var sig minisign.Signature
	if err = sig.UnmarshalText(raw); err != nil {
		return nil, err
	}
	// Tauri emits hashed minisign signatures. Reject unbounded legacy messages.
	if sig.Algorithm != minisign.HashEdDSA {
		return nil, errors.New("Update must use a prehashed minisign signature")
	}
	return raw, nil
}

func (c *Client) publicKey() (minisign.PublicKey, error) {
	var key minisign.PublicKey
	text, err := base64.StdEncoding.DecodeString(c.PublicKey)
	if err != nil {
		return key, err
	}
	return key, key.UnmarshalText(text)
}

// Download streams the update (an installer, or an app archive on macOS) into dir and returns its path only after the
// signature verifies. A failed download leaves no file behind.
func (c *Client) Download(ctx context.Context, release Release, dir string, progress func(Progress)) (path string, err error) {
	if err = c.validURL(release.URL); err != nil {
		return "", err
	}
	signature, err := decodeSignature(release.Signature)
	if err != nil {
		return "", err
	}
	key, err := c.publicKey()
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, release.URL, nil)
	if err != nil {
		return "", err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Download returned HTTP %d", res.StatusCode)
	}
	if res.ContentLength > maxDownload {
		return "", errors.New("Update exceeds size limit")
	}
	file, err := os.CreateTemp(dir, downloadPattern)
	if err != nil {
		return "", err
	}
	path = file.Name()
	success := false
	defer func() {
		file.Close()
		if !success {
			os.Remove(file.Name())
		}
	}()
	emit := func(p Progress) {
		if progress != nil {
			progress(p)
		}
	}
	length := res.ContentLength
	if length < 0 {
		length = 0
	}
	emit(Progress{Event: "Started", Data: map[string]int64{"contentLength": length}})
	reader := minisign.NewReader(io.LimitReader(res.Body, maxDownload+1))
	buf := make([]byte, 64<<10)
	var total int64
	for {
		n, readErr := reader.Read(buf)
		if n > 0 {
			total += int64(n)
			if total > maxDownload {
				return "", errors.New("Update exceeds size limit")
			}
			if _, err = file.Write(buf[:n]); err != nil {
				return "", err
			}
			emit(Progress{Event: "Progress", Data: map[string]int64{"chunkLength": int64(n)}})
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return "", readErr
		}
		if err = ctx.Err(); err != nil {
			return "", err
		}
	}
	if res.ContentLength >= 0 && total != res.ContentLength {
		return "", errors.New("Incomplete update download")
	}
	if !reader.Verify(key, signature) {
		return "", errors.New("Update signature verification failed")
	}
	if err = file.Sync(); err != nil {
		return "", err
	}
	if err = file.Close(); err != nil {
		return "", err
	}
	success = true
	emit(Progress{Event: "Finished"})
	return path, nil
}
