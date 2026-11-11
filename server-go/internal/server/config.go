package server

import (
	"encoding/hex"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

// Config is the server's environment (see Config::from_env in server-rs,
// whose names and defaults these are).
type Config struct {
	Port              uint16
	BindAddress       netip.Addr
	TrustedProxyCIDRs []string
	DatabaseURL       string
	JWTSecret         string
	FrontendURL       *string
	AppURL            *string
	// AllowedOrigins are extra exact origins (other domains, the public IP)
	// that serve the same app.
	AllowedOrigins      []string
	FrontendHashRouter  bool
	LogLevel            string
	PistonURL           string
	AdminUsername       string
	AdminPassword       string
	AdminEmail          string
	AdminUpdatePassword bool
	// ClientReleasesDir is where uploaded desktop client installers and
	// update bundles are kept.
	ClientReleasesDir string
	// ClientUpdaterPubkey is the desktop client's update signing public key
	// (plugins.updater.pubkey in its tauri.conf.json). Uploaded signatures
	// are checked against it, as the client does.
	ClientUpdaterPubkey string
	// ClientReleasesCITokenSHA256 is the SHA-256 of the token the release
	// workflow presents (CLIENT_RELEASES_CI_TOKEN_SHA256, hex). Nil: no CI
	// uploads.
	ClientReleasesCITokenSHA256 *[32]byte
}

// ClientUpdaterPubkeyDefault is the public key the desktop client trusts;
// keep in sync with frontend/src-tauri-client/tauri.conf.json (a test
// checks this).
const ClientUpdaterPubkeyDefault = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEZFQzk4NDk1Mzg3RTQ1MUYKUldRZlJYNDRsWVRKL3JtQXFGMlc2YWZSL2M3eUpQQ0dCTm8vdDg4S1A0dGw5am9wN1U3NzNjNzEK"

func envOr(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func envOpt(key string) *string {
	if value, ok := os.LookupEnv(key); ok {
		return &value
	}
	return nil
}

func envList(key string) []string {
	var out []string
	for _, part := range strings.Split(os.Getenv(key), ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

func parseBool(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

func envBool(key string, fallback bool) bool {
	if value, ok := os.LookupEnv(key); ok {
		return parseBool(value)
	}
	return fallback
}

// parseSHA256Hex reads a SHA-256 digest written as 64 hex digits.
func parseSHA256Hex(value string) *[32]byte {
	raw, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(raw) != 32 {
		return nil
	}
	var out [32]byte
	copy(out[:], raw)
	return &out
}

// ConfigFromEnv reads the configuration. It panics on an invalid
// BIND_ADDRESS, as the Rust server does.
func ConfigFromEnv() *Config {
	port := uint16(3001)
	if n, err := strconv.ParseUint(os.Getenv("PORT"), 10, 16); err == nil {
		port = uint16(n)
	}
	bind, err := netip.ParseAddr(envOr("BIND_ADDRESS", "0.0.0.0"))
	if err != nil {
		panic("Invalid BIND_ADDRESS")
	}
	pubkey := strings.TrimSpace(os.Getenv("CLIENT_UPDATER_PUBKEY"))
	if pubkey == "" {
		pubkey = ClientUpdaterPubkeyDefault
	}
	var ciToken *[32]byte
	if value := os.Getenv("CLIENT_RELEASES_CI_TOKEN_SHA256"); strings.TrimSpace(value) != "" {
		ciToken = parseSHA256Hex(value)
	}
	return &Config{
		Port:                        port,
		BindAddress:                 bind,
		TrustedProxyCIDRs:           envList("TRUSTED_PROXY_CIDRS"),
		DatabaseURL:                 envOr("DATABASE_URL", "postgresql://sharecode:sharecode@localhost:5432/sharecode"),
		JWTSecret:                   envOr("JWT_SECRET", "dev-jwt-secret-change-this-in-production-please"),
		FrontendURL:                 envOpt("FRONTEND_URL"),
		AppURL:                      envOpt("APP_URL"),
		AllowedOrigins:              envList("ALLOWED_ORIGINS"),
		FrontendHashRouter:          envBool("FRONTEND_HASH_ROUTER", false),
		LogLevel:                    envOr("LOG_LEVEL", "info"),
		PistonURL:                   envOr("PISTON_URL", "http://localhost:2000"),
		AdminUsername:               envOr("ADMIN_USERNAME", "admin"),
		AdminPassword:               envOr("ADMIN_PASSWORD", "ChangeMe123!"),
		AdminEmail:                  envOr("ADMIN_EMAIL", "admin@sharecode.local"),
		AdminUpdatePassword:         envBool("ADMIN_UPDATE_PASSWORD", false),
		ClientReleasesDir:           envOr("CLIENT_RELEASES_DIR", "data/client-releases"),
		ClientUpdaterPubkey:         pubkey,
		ClientReleasesCITokenSHA256: ciToken,
	}
}
