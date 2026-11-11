package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/google/uuid"
)

// sessionDays is how long a browser session and its cookie last.
const sessionDays = 30

// originOf is the ASCII serialization of a URL's origin, as the url crate
// gives it: scheme://host, with the port only when it is not the scheme's
// own. ok is false for what is not an http(s) URL with a host.
func originOf(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := u.Port()
	if port == "" || (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		return u.Scheme + "://" + host, true
	}
	return u.Scheme + "://" + host + ":" + port, true
}

// allowedOrigin accepts exact origins only, never suffixes or whatever the
// caller sends.
func allowedOrigin(config *Config, origin string) bool {
	var configured []string
	if config.FrontendURL != nil {
		configured = append(configured, *config.FrontendURL)
	}
	if config.AppURL != nil {
		configured = append(configured, *config.AppURL)
	}
	configured = append(configured, config.AllowedOrigins...)
	for _, value := range configured {
		for _, one := range strings.Split(value, ",") {
			if o, ok := originOf(one); ok && o == origin {
				return true
			}
		}
	}
	switch origin {
	case "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost":
		return true
	}
	return false
}

func checkOrigin(config *Config, header http.Header) error {
	if values, ok := header["Origin"]; ok && len(values) > 0 {
		if !allowedOrigin(config, values[0]) {
			return forbidden("Untrusted request origin")
		}
	}
	return nil
}

// checkCookieRequest guards the requests that act on the session cookie.
func checkCookieRequest(config *Config, header http.Header) error {
	if err := checkOrigin(config, header); err != nil {
		return err
	}
	// A custom header requires CORS preflight and cannot be sent by HTML forms.
	if header.Get("X-Sharecode-Client") != "web" {
		return forbidden("Missing session request header")
	}
	return nil
}

// secureCookie is false only for explicit HTTP loopback development.
func secureCookie(config *Config) bool {
	value := config.AppURL
	if value == nil {
		value = config.FrontendURL
	}
	if value == nil {
		return true
	}
	u, err := url.Parse(*value)
	if err != nil || u.Scheme != "http" {
		return true
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "::1":
		return false
	}
	return true
}

func cookieName(config *Config) string {
	if secureCookie(config) {
		return "__Host-sharecode-session"
	}
	return "sharecode-session"
}

// cookieHeader is the Set-Cookie value for the session secret; an empty
// secret clears the cookie.
func cookieHeader(config *Config, secret string) string {
	maxAge := sessionDays * 24 * 60 * 60
	if secret == "" {
		maxAge = 0
	}
	value := fmt.Sprintf("%s=%s; HttpOnly; SameSite=Lax", cookieName(config), secret)
	if secureCookie(config) {
		value += "; Secure"
	}
	return value + fmt.Sprintf("; Path=/; Max-Age=%d", maxAge)
}

// cookieSecret reads the session secret from the request: exactly one
// cookie of the name, 43 URL-safe characters. Anything else is none.
func cookieSecret(config *Config, header http.Header) *string {
	name := cookieName(config)
	var found *string
	for _, line := range header.Values("Cookie") {
		if line != "" && visibleASCII(line) == "" {
			return nil
		}
		for _, part := range strings.Split(line, ";") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			key, value, ok := strings.Cut(part, "=")
			if !ok || strings.TrimSpace(key) == "" {
				return nil
			}
			if strings.TrimSpace(key) != name {
				continue
			}
			value = strings.TrimSpace(value)
			if found != nil || len(value) != 43 || strings.ContainsFunc(value, func(c rune) bool {
				return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')
			}) {
				return nil
			}
			found = &value
		}
	}
	return found
}

func secretHash(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

// createSession stores a browser session for user and returns its ID and
// the secret for the cookie.
func createSession(ctx context.Context, tx DBTX, user *UserRow, deviceID *uuid.UUID) (id, secret string, err error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", internalError("Failed to create browser session")
	}
	secret = base64.RawURLEncoding.EncodeToString(raw[:])
	id = uuid.NewString()
	if _, err := tx.Exec(ctx, `INSERT INTO "BrowserSession" (id,"userId","secretHash","tokenVersion","deviceId","expiresAt")
        VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '30 days')`, id, user.ID, secretHash(secret), user.TokenVersion, deviceID); err != nil {
		return "", "", dbError(err, "Failed to create browser session")
	}
	// Expired rows have no authentication value; the expiry index bounds cleanup.
	if _, err := tx.Exec(ctx, `DELETE FROM "BrowserSession" WHERE "expiresAt" <= NOW()`); err != nil {
		return "", "", dbError(err, "Failed to remove expired browser sessions")
	}
	return id, secret, nil
}

// loadSessionUser loads a live account for a session, locked for share.
func loadSessionUser(ctx context.Context, tx DBTX, id string) (*UserRow, error) {
	user, err := queryOptional[UserRow](ctx, tx, `SELECT `+userRowColumns+`
        FROM "User" WHERE id=$1 AND NOT "isDeleted" FOR SHARE`, id)
	if err != nil {
		return nil, dbError(err, "Failed to load session user")
	}
	if user == nil {
		return nil, unauthorized("Session expired")
	}
	return user, nil
}
