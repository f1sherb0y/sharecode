package server

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"golang.org/x/crypto/blake2b"
)

// Desktop client releases, like GitHub releases: an admin creates a draft for a version,
// uploads its files per platform and publishes it. Published releases are frozen (unpublish to
// change one). The download page offers each platform's newest installer, and the client's
// updater (tauri-plugin-updater) asks the update endpoint, a Tauri "dynamic update server",
// for the newest signed update. Files are kept on disk under CLIENT_RELEASES_DIR, named by
// asset ID; the database keeps their names, sizes, SHA-256 and update signatures.

func init() {
	registrars = append(registrars, func(a *App, mux *http.ServeMux) {
		// Desktop client releases: publishing (admins), downloads and the in-app updater
		mux.HandleFunc("GET /api/admin/client-releases", h(a.listReleases))
		mux.HandleFunc("POST /api/admin/client-releases", h(a.createRelease))
		mux.HandleFunc("PATCH /api/admin/client-releases/{id}", h(a.updateRelease))
		mux.HandleFunc("DELETE /api/admin/client-releases/{id}", h(a.deleteRelease))
		mux.HandleFunc("POST /api/admin/client-releases/{id}/assets", h(a.uploadAsset))
		mux.HandleFunc("DELETE /api/admin/client-releases/{id}/assets/{assetId}", h(a.deleteAsset))
		mux.HandleFunc("PUT /api/ci/client-releases/{version}", h(a.openCiDraft))
		mux.HandleFunc("GET /api/client/releases/latest", h(a.latestDownloads))
		mux.HandleFunc("GET /api/client/install.sh", h(a.macosInstallScript))
		mux.HandleFunc("GET /api/client/install.ps1", h(a.windowsInstallScript))
		mux.HandleFunc("GET /api/client/update/{target}/{arch}/{currentVersion}", h(a.updateCheck))
		mux.HandleFunc("GET /api/client/downloads/{assetId}/{fileName}", h(a.downloadAsset))
	})
}

// platforms are Tauri's `{target}-{arch}` platform names.
var platforms = []string{
	"windows-x86_64",
	"windows-aarch64",
	"darwin-aarch64",
	"darwin-x86_64",
	"linux-x86_64",
	"linux-aarch64",
}

var kinds = []string{"installer", "update"}

// releaseFileExtensions (FILE_EXTENSIONS in client_releases.rs; code.rs has
// its own) is what the Tauri bundler makes: Windows NSIS/MSI, macOS dmg and
// .app.tar.gz, Linux AppImage/deb/rpm, and the zipped/tarred updater bundles
// of older Tauri versions.
var releaseFileExtensions = []string{".exe", ".msi", ".dmg", ".tar.gz", ".zip", ".appimage", ".deb", ".rpm"}

const (
	// A Linux AppImage is around 100 MB; leave room for growth.
	maxAssetBytes = 512 * 1024 * 1024
	// The upload request: the file plus the other form fields.
	maxUploadBytes = maxAssetBytes + 1024*1024
	// releaseMaxNotesChars is MAX_NOTES_CHARS in client_releases.rs
	// (customers.rs has its own).
	releaseMaxNotesChars = 10_000
	maxSignatureChars    = 4096
	maxFileNameChars     = 200
)

type ReleaseRow struct {
	ID          string     `db:"id"`
	Version     string     `db:"version"`
	Notes       string     `db:"notes"`
	PublishedAt *time.Time `db:"published_at"`
	CreatedAt   time.Time  `db:"created_at"`
	UpdatedAt   time.Time  `db:"updated_at"`
	CreatedBy   *string    `db:"created_by"`
}

type AssetRow struct {
	ID        string    `db:"id"`
	ReleaseID string    `db:"release_id"`
	Platform  string    `db:"platform"`
	Kind      string    `db:"kind"`
	FileName  string    `db:"file_name"`
	Size      int64     `db:"size"`
	SHA256    string    `db:"sha256"`
	Signature *string   `db:"signature"`
	CreatedAt time.Time `db:"created_at"`
}

const releaseColumns = `r.id, r.version, r.notes, r."publishedAt" as published_at,
    r."createdAt" as created_at, r."updatedAt" as updated_at, u.username as created_by`
const assetColumns = `a.id, a."releaseId" as release_id, a.platform, a.kind, a."fileName" as file_name,
    a.size, a.sha256, a.signature, a."createdAt" as created_at`

// ----- Semantic versions (the Rust `semver` crate's Version) -----

// semverVersion is a parsed semantic version, with the parsing and the total
// order of the Rust semver crate (build metadata takes part in the order).
type semverVersion struct {
	major, minor, patch uint64
	pre, build          string
}

func (v semverVersion) String() string {
	out := fmt.Sprintf("%d.%d.%d", v.major, v.minor, v.patch)
	if v.pre != "" {
		out += "-" + v.pre
	}
	if v.build != "" {
		out += "+" + v.build
	}
	return out
}

func semverNumericIdentifier(input string) (value uint64, rest string, ok bool) {
	length := 0
	for length < len(input) {
		digit := input[length]
		if digit < '0' || digit > '9' {
			break
		}
		if value == 0 && length > 0 {
			return 0, "", false // leading zero
		}
		d := uint64(digit - '0')
		if value > (^uint64(0)-d)/10 {
			return 0, "", false // overflow
		}
		value = value*10 + d
		length++
	}
	if length == 0 {
		return 0, "", false
	}
	return value, input[length:], true
}

// semverIdentifier reads the dot-separated identifiers of a prerelease or of
// build metadata from the start of input.
func semverIdentifier(input string, pre bool) (identifier, rest string, ok bool) {
	accumulated, segment := 0, 0
	hasNonDigit := false
	for {
		var boundary byte
		atEnd := accumulated+segment >= len(input)
		if !atEnd {
			boundary = input[accumulated+segment]
			switch {
			case boundary >= 'A' && boundary <= 'Z', boundary >= 'a' && boundary <= 'z', boundary == '-':
				segment++
				hasNonDigit = true
				continue
			case boundary >= '0' && boundary <= '9':
				segment++
				continue
			}
		}
		isDot := !atEnd && boundary == '.'
		if segment == 0 {
			if accumulated == 0 && !isDot {
				return "", input, true
			}
			return "", "", false // empty segment
		}
		if pre && segment > 1 && !hasNonDigit && input[accumulated] == '0' {
			return "", "", false // leading zero
		}
		accumulated += segment
		if !isDot {
			return input[:accumulated], input[accumulated:], true
		}
		accumulated++
		segment = 0
		hasNonDigit = false
	}
}

// parseSemver is semver::Version::parse.
func parseSemver(text string) (semverVersion, bool) {
	var v semverVersion
	var ok bool
	if text == "" {
		return v, false
	}
	if v.major, text, ok = semverNumericIdentifier(text); !ok {
		return v, false
	}
	if text, ok = strings.CutPrefix(text, "."); !ok {
		return v, false
	}
	if v.minor, text, ok = semverNumericIdentifier(text); !ok {
		return v, false
	}
	if text, ok = strings.CutPrefix(text, "."); !ok {
		return v, false
	}
	if v.patch, text, ok = semverNumericIdentifier(text); !ok {
		return v, false
	}
	if text == "" {
		return v, true
	}
	if rest, found := strings.CutPrefix(text, "-"); found {
		if v.pre, text, ok = semverIdentifier(rest, true); !ok || v.pre == "" {
			return v, false
		}
	}
	if rest, found := strings.CutPrefix(text, "+"); found {
		if v.build, text, ok = semverIdentifier(rest, false); !ok || v.build == "" {
			return v, false
		}
	}
	if text != "" {
		return v, false
	}
	return v, true
}

func semverAllDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

func semverComparePre(a, b string) int {
	if a == b {
		return 0
	}
	if a == "" {
		// A real release compares greater than prerelease.
		return 1
	}
	if b == "" {
		return -1
	}
	lhs, rhs := strings.Split(a, "."), strings.Split(b, ".")
	for i, l := range lhs {
		if i >= len(rhs) {
			return 1
		}
		r := rhs[i]
		var ordering int
		switch lDigits, rDigits := semverAllDigits(l), semverAllDigits(r); {
		case lDigits && rDigits:
			if ordering = cmp.Compare(len(l), len(r)); ordering == 0 {
				ordering = strings.Compare(l, r)
			}
		case lDigits:
			return -1
		case rDigits:
			return 1
		default:
			ordering = strings.Compare(l, r)
		}
		if ordering != 0 {
			return ordering
		}
	}
	if len(rhs) > len(lhs) {
		return -1
	}
	return 0
}

func semverCompareBuild(a, b string) int {
	if a == b {
		return 0
	}
	lhs, rhs := strings.Split(a, "."), strings.Split(b, ".")
	for i, l := range lhs {
		if i >= len(rhs) {
			return 1
		}
		r := rhs[i]
		var ordering int
		switch lDigits, rDigits := semverAllDigits(l), semverAllDigits(r); {
		case lDigits && rDigits:
			// 0 < 00 < 1 < 01 < 001 < 2 < 02 < 002 < 10
			lval, rval := strings.TrimLeft(l, "0"), strings.TrimLeft(r, "0")
			if ordering = cmp.Compare(len(lval), len(rval)); ordering == 0 {
				if ordering = strings.Compare(lval, rval); ordering == 0 {
					ordering = cmp.Compare(len(l), len(r))
				}
			}
		case lDigits:
			return -1
		case rDigits:
			return 1
		default:
			ordering = strings.Compare(l, r)
		}
		if ordering != 0 {
			return ordering
		}
	}
	if len(rhs) > len(lhs) {
		return -1
	}
	return 0
}

// cmp is the Ord of semver::Version: major, minor, patch, prerelease, build.
func (v semverVersion) cmp(o semverVersion) int {
	if c := cmp.Compare(v.major, o.major); c != 0 {
		return c
	}
	if c := cmp.Compare(v.minor, o.minor); c != 0 {
		return c
	}
	if c := cmp.Compare(v.patch, o.patch); c != 0 {
		return c
	}
	if c := semverComparePre(v.pre, o.pre); c != 0 {
		return c
	}
	return semverCompareBuild(v.build, o.build)
}

func parseVersion(value string) (semverVersion, error) {
	version, ok := parseSemver(strings.TrimSpace(value))
	if !ok {
		return version, badRequest("Version must be a semantic version such as 1.2.3")
	}
	return version, nil
}

func releaseVersion(release *ReleaseRow) semverVersion {
	// Stored versions were validated on creation.
	version, ok := parseSemver(release.Version)
	if !ok {
		return semverVersion{}
	}
	return version
}

// ----- File names, signatures -----

// sanitizeFileName is the last path component of an uploaded file name,
// without control characters.
func sanitizeFileName(name string) (string, bool) {
	base := name
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		base = name[i+1:]
	}
	var cleaned strings.Builder
	taken := 0
	for _, c := range base {
		if unicode.IsControl(c) {
			continue
		}
		if taken == maxFileNameChars {
			break
		}
		cleaned.WriteRune(c)
		taken++
	}
	result := strings.TrimSpace(cleaned.String())
	if result == "" || result == "." || result == ".." {
		return "", false
	}
	return result, true
}

func asciiLower(s string) string {
	out := []byte(s)
	for i, c := range out {
		if c >= 'A' && c <= 'Z' {
			out[i] = c + ('a' - 'A')
		}
	}
	return string(out)
}

func hasReleaseExtension(fileName string) bool {
	name := asciiLower(fileName)
	for _, extension := range releaseFileExtensions {
		if strings.HasSuffix(name, extension) {
			return true
		}
	}
	return false
}

// strictBase64 decodes standard padded base64 without the line breaks Go's
// decoder would skip, as the Rust decoders do.
func strictBase64(value string) ([]byte, bool) {
	if strings.ContainsAny(value, "\r\n") {
		return nil, false
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(value)
	return raw, err == nil
}

func decodeBase64Text(value string) (string, bool) {
	raw, ok := strictBase64(strings.TrimSpace(value))
	if !ok || !utf8.Valid(raw) {
		return "", false
	}
	return string(raw), true
}

// rustLines is str::lines: split at "\n", each line without one trailing
// "\r", and no empty last line after a final line break.
func rustLines(text string) []string {
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

// minisignSignature is minisign_verify::Signature.
type minisignSignature struct {
	keyID           [8]byte
	signature       [64]byte
	trustedComment  string // the whole line, with "trusted comment: "
	globalSignature [64]byte
	isPrehashed     bool
}

// decodeMinisignSignature is Signature::decode.
func decodeMinisignSignature(text string) (*minisignSignature, bool) {
	lines := rustLines(text)
	if len(lines) < 4 {
		return nil, false
	}
	bin1, ok := strictBase64(lines[1])
	if !ok || len(bin1) != 74 {
		return nil, false
	}
	trustedComment := lines[2]
	bin2, ok := strictBase64(lines[3])
	if !ok || len(bin2) != 64 {
		return nil, false
	}
	if !strings.HasPrefix(trustedComment, "trusted comment: ") {
		return nil, false
	}
	signature := &minisignSignature{trustedComment: trustedComment}
	copy(signature.keyID[:], bin1[2:10])
	copy(signature.signature[:], bin1[10:74])
	copy(signature.globalSignature[:], bin2)
	switch {
	case bin1[0] == 0x45 && bin1[1] == 0x64:
		signature.isPrehashed = false
	case bin1[0] == 0x45 && bin1[1] == 0x44:
		signature.isPrehashed = true
	default:
		return nil, false
	}
	return signature, true
}

// minisignPublicKey is minisign_verify::PublicKey.
type minisignPublicKey struct {
	keyID [8]byte
	key   [32]byte
}

// decodeMinisignPublicKey is PublicKey::decode.
func decodeMinisignPublicKey(text string) (*minisignPublicKey, bool) {
	lines := rustLines(text)
	if len(lines) < 2 {
		return nil, false
	}
	bin, ok := strictBase64(lines[1])
	if !ok || len(bin) != 42 {
		return nil, false
	}
	if !(bin[0] == 0x45 && (bin[1] == 0x64 || bin[1] == 0x44)) {
		return nil, false
	}
	key := &minisignPublicKey{}
	copy(key.keyID[:], bin[2:10])
	copy(key.key[:], bin[10:42])
	return key, true
}

// parseSignature reads a Tauri `.sig` file: a base64-encoded minisign
// signature.
func parseSignature(value string) (string, *minisignSignature, error) {
	invalid := func() error { return badRequest("The signature must be the content of the .sig file") }
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxSignatureChars {
		return "", nil, invalid()
	}
	text, ok := decodeBase64Text(value)
	if !ok {
		return "", nil, invalid()
	}
	signature, ok := decodeMinisignSignature(text)
	if !ok {
		return "", nil, invalid()
	}
	return value, signature, nil
}

func updaterPublicKey(config *Config) (*minisignPublicKey, error) {
	if text, ok := decodeBase64Text(config.ClientUpdaterPubkey); ok {
		if key, ok := decodeMinisignPublicKey(text); ok {
			return key, nil
		}
	}
	slog.Error("CLIENT_UPDATER_PUBKEY is not a Tauri updater public key")
	return nil, internalError("The update signing key is misconfigured")
}

// verifySignature is the check tauri-plugin-updater makes before installing
// an update, so a release only offers updates the client accepts. Streams
// the file: Tauri signs a BLAKE2b prehash.
func verifySignature(publicKey *minisignPublicKey, signature *minisignSignature, path string) error {
	mismatch := func() error {
		return badRequest("The signature does not match this file or was not made with the client's signing key")
	}
	// PublicKey::verify_stream: the same key, and never the legacy mode.
	if publicKey.keyID != signature.keyID || !signature.isPrehashed {
		return mismatch()
	}
	hasher, err := blake2b.New512(nil)
	if err != nil {
		return mismatch()
	}
	file, err := os.Open(path)
	if err != nil {
		return storageError(err)
	}
	defer file.Close()
	if _, err := io.CopyBuffer(hasher, file, make([]byte, 1024*1024)); err != nil {
		return storageError(err)
	}
	key := ed25519.PublicKey(publicKey.key[:])
	if !ed25519.Verify(key, hasher.Sum(nil), signature.signature[:]) {
		return mismatch()
	}
	global := append(append([]byte{}, signature.signature[:]...), signature.trustedComment[len("trusted comment: "):]...)
	if !ed25519.Verify(key, global, signature.globalSignature[:]) {
		return mismatch()
	}
	return nil
}

func assetPath(config *Config, assetID string) string {
	return filepath.Join(config.ClientReleasesDir, assetID)
}

// encodePathSegment is form_urlencoded::byte_serialize with "%20" for a
// space.
func encodePathSegment(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '*', c == '-', c == '.', c == '_':
			out.WriteByte(c)
		default:
			fmt.Fprintf(&out, "%%%02X", c)
		}
	}
	return out.String()
}

// downloadPath is the file's public URL path. Ending in the file name keeps
// it for browsers and download managers that name files after the URL.
func downloadPath(asset *AssetRow) string {
	return fmt.Sprintf("/api/client/downloads/%s/%s", asset.ID, encodePathSegment(asset.FileName))
}

// publicOrigin is the configured origin (APP_URL, FRONTEND_URL,
// ALLOWED_ORIGINS) the request came in on, so a client updates through the
// node it reached; otherwise the main one. host is the request's Host
// header, "" without one.
func publicOrigin(config *Config, host string) (string, bool) {
	type origin struct{ serialized, authority string }
	var values []string
	if config.AppURL != nil {
		values = append(values, *config.AppURL)
	}
	if config.FrontendURL != nil {
		values = append(values, *config.FrontendURL)
	}
	values = append(values, config.AllowedOrigins...)
	var origins []origin
	for _, value := range values {
		for _, part := range strings.Split(value, ",") {
			parsed, err := url.Parse(strings.TrimSpace(part))
			if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
				continue
			}
			authority := asciiLower(parsed.Hostname())
			if strings.Contains(authority, ":") {
				authority = "[" + authority + "]"
			}
			// The url crate drops a scheme's default port.
			if port := parsed.Port(); port != "" {
				number, err := strconv.ParseUint(port, 10, 16)
				if err != nil {
					continue
				}
				if !(parsed.Scheme == "http" && number == 80) && !(parsed.Scheme == "https" && number == 443) {
					authority += ":" + strconv.FormatUint(number, 10)
				}
			}
			origins = append(origins, origin{parsed.Scheme + "://" + authority, authority})
		}
	}
	if host != "" {
		for _, candidate := range origins {
			if asciiLower(candidate.authority) == asciiLower(host) {
				return candidate.serialized, true
			}
		}
	}
	if len(origins) == 0 {
		return "", false
	}
	return origins[0].serialized, true
}

func assetJSON(asset *AssetRow) map[string]any {
	return map[string]any{
		"id":          asset.ID,
		"platform":    asset.Platform,
		"kind":        asset.Kind,
		"fileName":    asset.FileName,
		"size":        asset.Size,
		"sha256":      asset.SHA256,
		"signed":      asset.Signature != nil,
		"createdAt":   isoString(asset.CreatedAt),
		"downloadUrl": downloadPath(asset),
	}
}

func releaseJSON(release *ReleaseRow, assets []AssetRow) map[string]any {
	files := []map[string]any{}
	for i := range assets {
		if assets[i].ReleaseID == release.ID {
			files = append(files, assetJSON(&assets[i]))
		}
	}
	return map[string]any{
		"id":          release.ID,
		"version":     release.Version,
		"notes":       release.Notes,
		"publishedAt": isoStringOpt(release.PublishedAt),
		"createdAt":   isoString(release.CreatedAt),
		"updatedAt":   isoString(release.UpdatedAt),
		"createdBy":   release.CreatedBy,
		"assets":      files,
	}
}

// loadReleases loads the releases, newest version first, with their files.
func (a *App) loadReleases(ctx context.Context, publishedOnly bool) ([]ReleaseRow, []AssetRow, error) {
	filter := ""
	if publishedOnly {
		filter = `WHERE r."publishedAt" IS NOT NULL`
	}
	releases, err := queryAll[ReleaseRow](ctx, a.DB,
		`SELECT `+releaseColumns+` FROM "ClientRelease" r LEFT JOIN "User" u ON u.id = r."createdBy" `+filter)
	if err != nil {
		return nil, nil, dbError(err, "Failed to load client releases")
	}
	slices.SortStableFunc(releases, func(x, y ReleaseRow) int {
		return releaseVersion(&y).cmp(releaseVersion(&x))
	})
	assets, err := queryAll[AssetRow](ctx, a.DB,
		`SELECT `+assetColumns+` FROM "ClientReleaseAsset" a JOIN "ClientRelease" r ON r.id = a."releaseId" `+filter+`
        ORDER BY a.platform, a.kind`)
	if err != nil {
		return nil, nil, dbError(err, "Failed to load client release files")
	}
	return releases, assets, nil
}

func loadRelease(ctx context.Context, db DBTX, id string, lock bool) (*ReleaseRow, error) {
	lockSQL := ""
	if lock {
		lockSQL = "FOR UPDATE OF r"
	}
	release, err := queryOptional[ReleaseRow](ctx, db,
		`SELECT `+releaseColumns+` FROM "ClientRelease" r LEFT JOIN "User" u ON u.id = r."createdBy"
        WHERE r.id = $1 `+lockSQL, id)
	if err != nil {
		return nil, dbError(err, "Failed to load client release")
	}
	if release == nil {
		return nil, notFound("Release not found")
	}
	return release, nil
}

func releaseAssets(ctx context.Context, db DBTX, id string) ([]AssetRow, error) {
	assets, err := queryAll[AssetRow](ctx, db,
		`SELECT `+assetColumns+` FROM "ClientReleaseAsset" a WHERE a."releaseId" = $1 ORDER BY a.platform, a.kind`, id)
	if err != nil {
		return nil, dbError(err, "Failed to load client release files")
	}
	return assets, nil
}

func requireDraft(release *ReleaseRow) error {
	if release.PublishedAt != nil {
		return conflict("Published releases cannot be changed; unpublish it first")
	}
	return nil
}

func removeFile(config *Config, assetID string) {
	if err := os.Remove(assetPath(config, assetID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("failed to remove client release file", "error", err, "asset_id", assetID)
	}
}

func storageError(err error) *ApiError {
	slog.Error("client release storage failed", "error", err)
	return internalError("Release storage is not available")
}

// ----- Who may change releases -----

// ciName is the name audit events and drafts carry for the release
// workflow; usernames cannot contain spaces, so it is never an account's.
const ciName = "CI workflow"

// ciTokenPresented tells whether the request carries the CI token, the
// token whose SHA-256 is CLIENT_RELEASES_CI_TOKEN_SHA256; enabled is false
// when CI uploads are off. The release workflow only opens drafts and
// uploads their files: it never publishes, edits or deletes.
func (a *App) ciTokenPresented(r *http.Request) (presented, enabled bool) {
	expected := a.Config.ClientReleasesCITokenSHA256
	if expected == nil {
		return false, false
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	token = strings.TrimSpace(token)
	if !ok || token == "" {
		return false, true
	}
	actual := sha256.Sum256([]byte(token))
	// Compare every byte, whatever the first difference.
	return subtle.ConstantTimeCompare(actual[:], expected[:]) == 1, true
}

// ciToken is the CiToken extractor.
func (a *App) ciToken(r *http.Request) error {
	presented, enabled := a.ciTokenPresented(r)
	switch {
	case !enabled:
		return notFound("Not found")
	case !presented:
		return unauthorized("Invalid token")
	}
	return nil
}

// Uploader is an admin, or the release workflow by its CI token (Admin is
// nil): who may upload a draft's files.
type Uploader struct {
	Admin *AuthUser
}

func (u *Uploader) actorID() *string {
	if u.Admin != nil {
		return &u.Admin.ID
	}
	return nil
}

func (u *Uploader) actorName() string {
	if u.Admin != nil {
		return u.Admin.Username
	}
	return ciName
}

// uploader is the Uploader extractor.
func (a *App) uploader(r *http.Request) (*Uploader, error) {
	if presented, _ := a.ciTokenPresented(r); presented {
		return &Uploader{}, nil
	}
	admin, err := a.adminUser(r)
	if err != nil {
		return nil, err
	}
	return &Uploader{Admin: admin}, nil
}

// ----- Admin -----

func (a *App) listReleases(w http.ResponseWriter, r *http.Request) error {
	if _, err := a.adminUser(r); err != nil {
		return err
	}
	releases, assets, err := a.loadReleases(r.Context(), false)
	if err != nil {
		return err
	}
	out := []map[string]any{}
	for i := range releases {
		out = append(out, releaseJSON(&releases[i], assets))
	}
	writeJSON(w, http.StatusOK, map[string]any{"releases": out})
	return nil
}

// serdeString is a String field with #[serde(default)]: absent is "", but
// null is refused as serde refuses it.
type serdeString string

func (s *serdeString) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		return errors.New("invalid type: null, expected a string")
	}
	return json.Unmarshal(data, (*string)(s))
}

type CreateReleasePayload struct {
	Version *string     `json:"version"`
	Notes   serdeString `json:"notes"`
}

func validateNotes(notes string) (string, error) {
	notes = strings.TrimSpace(notes)
	if utf8.RuneCountInString(notes) > releaseMaxNotesChars {
		return "", badRequest("Release notes are too long")
	}
	return notes, nil
}

func (a *App) createRelease(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	admin, err := a.adminUser(r)
	if err != nil {
		return err
	}
	var payload CreateReleasePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}
	if err := requireFields("version", payload.Version); err != nil {
		return err
	}
	parsed, err := parseVersion(*payload.Version)
	if err != nil {
		return err
	}
	version := parsed.String()
	notes, err := validateNotes(string(payload.Notes))
	if err != nil {
		return err
	}
	id := uuid.NewString()

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	inserted, err := tx.Exec(ctx, `INSERT INTO "ClientRelease" (id, version, notes, "createdBy") VALUES ($1, $2, $3, $4)
        ON CONFLICT (version) DO NOTHING`, id, version, notes, admin.ID)
	if err != nil {
		return dbError(err, "Failed to create client release")
	}
	if inserted.RowsAffected() == 0 {
		return conflict("This version already exists")
	}
	if err := recordDetails(ctx, tx, client, "client_release.created", &admin.ID, &admin.Username,
		&id, true, nil, nil, map[string]any{"version": version}); err != nil {
		return err
	}
	release, err := loadRelease(ctx, tx, id, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}

	writeJSON(w, http.StatusCreated, map[string]any{"release": releaseJSON(release, nil)})
	return nil
}

type UpdateReleasePayload struct {
	Notes     *string `json:"notes"`
	Published *bool   `json:"published"`
}

func (a *App) updateRelease(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	admin, err := a.adminUser(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	var payload UpdateReleasePayload
	if err := readJSON(w, r, &payload); err != nil {
		return err
	}

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	release, err := loadRelease(ctx, tx, id, true)
	if err != nil {
		return err
	}
	assets, err := releaseAssets(ctx, tx, id)
	if err != nil {
		return err
	}

	// Notes stay editable after publishing (wording fixes); files and the version do not.
	if payload.Notes != nil {
		notes, err := validateNotes(*payload.Notes)
		if err != nil {
			return err
		}
		if notes != release.Notes {
			if _, err := tx.Exec(ctx, `UPDATE "ClientRelease" SET notes = $2, "updatedAt" = NOW() WHERE id = $1`, id, notes); err != nil {
				return dbError(err, "Failed to update client release")
			}
			if err := recordDetails(ctx, tx, client, "client_release.notes_updated", &admin.ID, &admin.Username,
				&id, true, nil, nil, map[string]any{"version": release.Version}); err != nil {
				return err
			}
		}
	}

	switch {
	case payload.Published != nil && *payload.Published && release.PublishedAt == nil:
		if !slices.ContainsFunc(assets, func(asset AssetRow) bool { return asset.Kind == "installer" }) {
			return badRequest("Upload at least one installer before publishing")
		}
		if _, err := tx.Exec(ctx, `UPDATE "ClientRelease" SET "publishedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1`, id); err != nil {
			return dbError(err, "Failed to publish client release")
		}
		files := []string{}
		for _, asset := range assets {
			signed := ""
			if asset.Signature != nil {
				signed = ":signed"
			}
			files = append(files, asset.Platform+":"+asset.Kind+signed)
		}
		if err := recordDetails(ctx, tx, client, "client_release.published", &admin.ID, &admin.Username,
			&id, true, nil, nil, map[string]any{"version": release.Version, "files": files}); err != nil {
			return err
		}
	case payload.Published != nil && !*payload.Published && release.PublishedAt != nil:
		if _, err := tx.Exec(ctx, `UPDATE "ClientRelease" SET "publishedAt" = NULL, "updatedAt" = NOW() WHERE id = $1`, id); err != nil {
			return dbError(err, "Failed to unpublish client release")
		}
		if err := recordDetails(ctx, tx, client, "client_release.unpublished", &admin.ID, &admin.Username,
			&id, true, nil, nil, map[string]any{"version": release.Version}); err != nil {
			return err
		}
	}

	release, err = loadRelease(ctx, tx, id, false)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	writeJSON(w, http.StatusOK, map[string]any{"release": releaseJSON(release, assets)})
	return nil
}

func (a *App) deleteRelease(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	admin, err := a.adminUser(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	release, err := loadRelease(ctx, tx, id, true)
	if err != nil {
		return err
	}
	if err := requireDraft(release); err != nil {
		return err
	}
	assets, err := releaseAssets(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM "ClientRelease" WHERE id = $1`, id); err != nil {
		return dbError(err, "Failed to delete client release")
	}
	if err := recordDetails(ctx, tx, client, "client_release.deleted", &admin.ID, &admin.Username,
		&id, true, nil, nil, map[string]any{"version": release.Version}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	for _, asset := range assets {
		removeFile(a.Config, asset.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"message": "Release deleted"})
	return nil
}

type AssetFields struct {
	platform  *string
	kind      *string
	signature *string
}

type ReceivedFile struct {
	name   string
	size   uint64
	sha256 string
}

func isASCIIWhitespace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\x0c' || b == '\r'
}

func trimASCIIWhitespaceThen(s string, char byte) (string, bool) {
	for len(s) > 0 && isASCIIWhitespace(s[0]) {
		s = s[1:]
	}
	if len(s) > 0 && s[0] == char {
		return s[1:], true
	}
	return "", false
}

// contentDispositionAttr reads `name` or `filename` from a part's
// Content-Disposition header the way multer (axum's multipart parser) does.
// Go's own Part.FileName would reduce the name to its last path component
// and decode RFC 2231 parameters, which multer does not.
func contentDispositionAttr(header, prefix string) (string, bool) {
	for {
		i := strings.Index(header, prefix)
		if i < 0 {
			return "", false
		}
		// Check if we found a superstring of `prefix`; continue if so.
		suffix := header[i+len(prefix):]
		if i > 0 && !(isASCIIWhitespace(header[i-1]) || header[i-1] == ';') {
			header = suffix
			continue
		}
		// Now find and trim the `=`. Handle quoted strings first.
		rest, ok := trimASCIIWhitespaceThen(suffix, '=')
		if !ok {
			return "", false
		}
		var value string
		escaped := false
		if quoted, ok := trimASCIIWhitespaceThen(rest, '"'); ok {
			k := strings.IndexByte(quoted, '"')
			if k < 0 {
				return "", false
			}
			for k > 0 && quoted[k-1] == '\\' {
				escaped = true
				next := strings.IndexByte(quoted[k+1:], '"')
				if next < 0 {
					return "", false
				}
				k = k + 1 + next
			}
			value = quoted[:k]
		} else {
			for len(rest) > 0 && isASCIIWhitespace(rest[0]) {
				rest = rest[1:]
			}
			j := strings.IndexAny(rest, "; ")
			if j < 0 {
				j = len(rest)
			}
			value = rest[:j]
		}
		if !utf8.ValidString(value) {
			return "", false
		}
		if escaped {
			value = strings.ReplaceAll(value, `\"`, `"`)
		}
		return value, true
	}
}

// multipartText is multer's Field::text for UTF-8: a leading byte order
// mark is dropped and malformed sequences are replaced.
func multipartText(part io.Reader) (string, error) {
	raw, err := io.ReadAll(part)
	if err != nil {
		return "", err
	}
	text := strings.TrimPrefix(string(raw), "\ufeff")
	return strings.ToValidUTF8(text, "\ufffd"), nil
}

// uploadAsset takes multipart fields: `platform`, `kind`, `signature` (the
// .sig file's content; required for update bundles) and `file`. Replaces
// the release's earlier file of that platform and kind.
func (a *App) uploadAsset(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	uploader, err := a.uploader(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	// axum's Multipart extractor: the boundary is checked before the handler
	// runs, and the body is limited to this route's own limit.
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/form-data" || params["boundary"] == "" {
		return &plainError{http.StatusBadRequest, "Invalid `boundary` for `multipart/form-data` request"}
	}
	form := multipart.NewReader(http.MaxBytesReader(w, r.Body, maxUploadBytes), params["boundary"])

	ctx := r.Context()
	// Refuse before receiving the file.
	release, err := loadRelease(ctx, a.DB, id, false)
	if err != nil {
		return err
	}
	if err := requireDraft(release); err != nil {
		return err
	}

	assetID := uuid.NewString()
	dir := a.Config.ClientReleasesDir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return storageError(err)
	}
	partial := filepath.Join(dir, "."+assetID+".part")

	var asset map[string]any
	fields, file, err := receiveAsset(form, partial)
	if err == nil {
		asset, err = a.storeAsset(ctx, client, uploader, id, assetID, partial, fields, file)
	}
	if err != nil {
		_ = os.Remove(partial)
		_ = os.Remove(assetPath(a.Config, assetID))
		return err
	}
	writeJSON(w, http.StatusCreated, map[string]any{"asset": asset})
	return nil
}

func receiveAsset(form *multipart.Reader, partial string) (*AssetFields, *ReceivedFile, error) {
	invalid := func() error { return badRequest("Invalid upload") }
	fields := &AssetFields{}
	var file *ReceivedFile
	for {
		// The raw part: multer does not decode quoted-printable either.
		part, err := form.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, invalid()
		}
		disposition := part.Header.Get("Content-Disposition")
		name, _ := contentDispositionAttr(disposition, "name")
		switch {
		case name == "platform":
			text, err := multipartText(part)
			if err != nil {
				return nil, nil, invalid()
			}
			fields.platform = ptr(strings.TrimSpace(text))
		case name == "kind":
			text, err := multipartText(part)
			if err != nil {
				return nil, nil, invalid()
			}
			fields.kind = ptr(strings.TrimSpace(text))
		case name == "signature":
			text, err := multipartText(part)
			if err != nil {
				return nil, nil, invalid()
			}
			fields.signature = nil
			if strings.TrimSpace(text) != "" {
				fields.signature = &text
			}
		case name == "file" && file == nil:
			received, err := receiveFile(part, disposition, partial)
			if err != nil {
				return nil, nil, err
			}
			file = received
		}
	}
	if file == nil {
		return nil, nil, badRequest("Choose a file to upload")
	}
	return fields, file, nil
}

// receiveFile streams the `file` field to partial, counting and hashing it
// on the way.
func receiveFile(part io.Reader, disposition, partial string) (*ReceivedFile, error) {
	name, ok := contentDispositionAttr(disposition, "filename")
	if ok {
		name, ok = sanitizeFileName(name)
	}
	if !ok {
		return nil, badRequest("The file needs a name")
	}
	if !hasReleaseExtension(name) {
		return nil, badRequest("Upload an installer or update bundle (.exe, .msi, .dmg, .app.tar.gz, .AppImage, .deb, .rpm)")
	}
	out, err := os.Create(partial)
	if err != nil {
		return nil, storageError(err)
	}
	defer out.Close()
	hasher := sha256.New()
	var size uint64
	buffer := make([]byte, 64*1024)
	for {
		n, err := part.Read(buffer)
		if n > 0 {
			size += uint64(n)
			if size > maxAssetBytes {
				return nil, badRequest("The file is too large")
			}
			hasher.Write(buffer[:n])
			if _, err := out.Write(buffer[:n]); err != nil {
				return nil, storageError(err)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, badRequest("Invalid upload")
		}
	}
	if err := out.Sync(); err != nil {
		return nil, storageError(err)
	}
	if size == 0 {
		return nil, badRequest("The file is empty")
	}
	return &ReceivedFile{name: name, size: size, sha256: hex.EncodeToString(hasher.Sum(nil))}, nil
}

func (a *App) storeAsset(ctx context.Context, client *ClientInfo, uploader *Uploader, releaseID, assetID, partial string,
	fields *AssetFields, file *ReceivedFile) (map[string]any, error) {
	if fields.platform == nil || !slices.Contains(platforms, *fields.platform) {
		return nil, badRequest("Unknown platform")
	}
	platform := *fields.platform
	if fields.kind == nil || !slices.Contains(kinds, *fields.kind) {
		return nil, badRequest("Unknown file kind")
	}
	kind := *fields.kind
	var signature *string
	switch {
	case fields.signature != nil:
		text, parsed, err := parseSignature(*fields.signature)
		if err != nil {
			return nil, err
		}
		publicKey, err := updaterPublicKey(a.Config)
		if err != nil {
			return nil, err
		}
		if err := verifySignature(publicKey, parsed, partial); err != nil {
			return nil, err
		}
		signature = &text
	case kind == "update":
		return nil, badRequest("Update bundles need their signature (.sig)")
	}

	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return nil, dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	release, err := loadRelease(ctx, tx, releaseID, true)
	if err != nil {
		return nil, err
	}
	if err := requireDraft(release); err != nil {
		return nil, err
	}
	replaced, err := scalarOptional[string](ctx, tx,
		`DELETE FROM "ClientReleaseAsset" WHERE "releaseId" = $1 AND platform = $2 AND kind = $3 RETURNING id`,
		releaseID, platform, kind)
	if err != nil {
		return nil, dbError(err, "Failed to replace client release file")
	}
	asset, err := queryOne[AssetRow](ctx, tx, `WITH a AS (
            INSERT INTO "ClientReleaseAsset" (id, "releaseId", platform, kind, "fileName", size, sha256, signature)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
        ) SELECT `+assetColumns+` FROM a`,
		assetID, releaseID, platform, kind, file.name, int64(file.size), file.sha256, signature)
	if err != nil {
		return nil, dbError(err, "Failed to save client release file")
	}
	if _, err := tx.Exec(ctx, `UPDATE "ClientRelease" SET "updatedAt" = NOW() WHERE id = $1`, releaseID); err != nil {
		return nil, dbError(err, "Failed to update client release")
	}
	if err := recordDetails(ctx, tx, client, "client_release.asset_uploaded", uploader.actorID(), ptr(uploader.actorName()),
		&releaseID, true, nil, nil,
		map[string]any{
			"version": release.Version, "platform": platform, "kind": kind, "fileName": file.name,
			"size": file.size, "sha256": file.sha256, "signed": signature != nil,
		}); err != nil {
		return nil, err
	}
	// In place before the commit, so a committed row always has its file.
	if err := os.Rename(partial, assetPath(a.Config, assetID)); err != nil {
		return nil, storageError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, dbError(err, "Failed to commit audited operation")
	}
	if replaced != nil {
		removeFile(a.Config, *replaced)
	}
	return assetJSON(&asset), nil
}

func (a *App) deleteAsset(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	admin, err := a.adminUser(r)
	if err != nil {
		return err
	}
	id, assetID := r.PathValue("id"), r.PathValue("assetId")

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	release, err := loadRelease(ctx, tx, id, true)
	if err != nil {
		return err
	}
	if err := requireDraft(release); err != nil {
		return err
	}
	type deletedAsset struct {
		Platform string `db:"platform"`
		Kind     string `db:"kind"`
	}
	deleted, err := queryOptional[deletedAsset](ctx, tx,
		`DELETE FROM "ClientReleaseAsset" WHERE id = $1 AND "releaseId" = $2 RETURNING platform, kind`, assetID, id)
	if err != nil {
		return dbError(err, "Failed to delete client release file")
	}
	if deleted == nil {
		return notFound("File not found")
	}
	if _, err := tx.Exec(ctx, `UPDATE "ClientRelease" SET "updatedAt" = NOW() WHERE id = $1`, id); err != nil {
		return dbError(err, "Failed to update client release")
	}
	if err := recordDetails(ctx, tx, client, "client_release.asset_deleted", &admin.ID, &admin.Username,
		&id, true, nil, nil,
		map[string]any{"version": release.Version, "platform": deleted.Platform, "kind": deleted.Kind}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	removeFile(a.Config, assetID)
	writeJSON(w, http.StatusOK, map[string]any{"message": "File deleted"})
	return nil
}

// ----- Release workflow (CI) -----

type CiDraftPayload struct {
	Notes serdeString `json:"notes"`
}

// openCiDraft opens the draft of a version for the release workflow, or
// returns the one already open (a rerun, or a draft an admin made), so files
// can be uploaded to it with the same token. Notes only go on a new draft; a
// published version is refused, since it is frozen.
func (a *App) openCiDraft(w http.ResponseWriter, r *http.Request) error {
	client, err := a.clientInfo(r)
	if err != nil {
		return err
	}
	if err := a.ciToken(r); err != nil {
		return err
	}
	rawVersion := r.PathValue("version")
	// Option<Json<T>>: no body without a Content-Type; with one it must be
	// JSON that deserializes.
	var payload CiDraftPayload
	if len(r.Header.Values("Content-Type")) > 0 {
		if err := readJSON(w, r, &payload); err != nil {
			return err
		}
	}
	parsed, err := parseVersion(rawVersion)
	if err != nil {
		return err
	}
	version := parsed.String()
	notes, err := validateNotes(string(payload.Notes))
	if err != nil {
		return err
	}
	id := uuid.NewString()

	ctx := r.Context()
	tx, err := a.DB.Begin(ctx)
	if err != nil {
		return dbError(err, "Failed to start audited operation")
	}
	defer tx.Rollback(context.Background())
	tag, err := tx.Exec(ctx, `INSERT INTO "ClientRelease" (id, version, notes, "createdBy") VALUES ($1, $2, $3, NULL)
        ON CONFLICT (version) DO NOTHING`, id, version, notes)
	if err != nil {
		return dbError(err, "Failed to create client release")
	}
	inserted := tag.RowsAffected() == 1
	existing, err := scalar[string](ctx, tx, `SELECT id FROM "ClientRelease" WHERE version = $1`, version)
	if err != nil {
		return dbError(err, "Failed to load client release")
	}
	release, err := loadRelease(ctx, tx, existing, true)
	if err != nil {
		return err
	}
	if err := requireDraft(release); err != nil {
		return err
	}
	if inserted {
		if err := recordDetails(ctx, tx, client, "client_release.created", nil, ptr(ciName),
			&release.ID, true, nil, nil, map[string]any{"version": version}); err != nil {
			return err
		}
	}
	assets, err := releaseAssets(ctx, tx, release.ID)
	if err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return dbError(err, "Failed to commit audited operation")
	}
	status := http.StatusOK
	if inserted {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"release": releaseJSON(release, assets)})
	return nil
}

// ----- Public -----

// latestInstaller is a platform's newest published installer.
func latestInstaller(releases []ReleaseRow, assets []AssetRow, platform string) (*ReleaseRow, *AssetRow) {
	for i := range releases {
		for j := range assets {
			if assets[j].ReleaseID == releases[i].ID && assets[j].Platform == platform && assets[j].Kind == "installer" {
				return &releases[i], &assets[j]
			}
		}
	}
	return nil, nil
}

// latestDownloads is each platform's newest published installer, for the
// download button.
func (a *App) latestDownloads(w http.ResponseWriter, r *http.Request) error {
	releases, assets, err := a.loadReleases(r.Context(), true)
	if err != nil {
		return err
	}
	downloads := []map[string]any{}
	for _, platform := range platforms {
		release, asset := latestInstaller(releases, assets, platform)
		if release == nil {
			continue
		}
		downloads = append(downloads, map[string]any{
			"platform":    platform,
			"version":     release.Version,
			"publishedAt": isoStringOpt(release.PublishedAt),
			"fileName":    asset.FileName,
			"size":        asset.Size,
			"sha256":      asset.SHA256,
			"url":         downloadPath(asset),
		})
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeJSON(w, http.StatusOK, map[string]any{"downloads": downloads})
	return nil
}

// ----- Install scripts -----

// The download page's one-line install commands fetch these and run them: zsh on macOS, where
// a browser download of the self-signed app is quarantined and Gatekeeper refuses it, and
// Windows PowerShell 5.1 on Windows. Each is rendered with this node's origin and the newest
// installer for both architectures (an Arm machine falls back to the x64/Intel build, as the
// download button does), so the script itself needs no JSON parsing. Running the command again
// updates or repairs an install; the client also keeps updating itself.

//go:embed client_install/install.zsh
var macosInstallScriptTemplate string

//go:embed client_install/install.ps1
var windowsInstallScriptTemplate string

func renderInstallScript(template, origin string, releases []ReleaseRow, assets []AssetRow, os string) (string, error) {
	x64Release, x64Asset := latestInstaller(releases, assets, os+"-x86_64")
	armRelease, armAsset := latestInstaller(releases, assets, os+"-aarch64")
	if armRelease == nil {
		armRelease, armAsset = x64Release, x64Asset
	}
	type value struct{ name, value string }
	values := []value{{"ORIGIN", origin}}
	for _, picked := range []struct {
		arch    string
		release *ReleaseRow
		asset   *AssetRow
	}{{"ARM64", armRelease, armAsset}, {"X64", x64Release, x64Asset}} {
		var version, url, sha256 string
		if picked.release != nil {
			version, url, sha256 = picked.release.Version, downloadPath(picked.asset), picked.asset.SHA256
		}
		values = append(values,
			value{picked.arch + "_VERSION", version},
			value{picked.arch + "_URL", url},
			value{picked.arch + "_SHA256", sha256})
	}
	script := strings.ReplaceAll(template, "\r\n", "\n")
	for _, v := range values {
		// Every value lands inside single quotes; none of them can hold one (origins are
		// serialized URLs, paths are percent-encoded, versions semantic, digests hex).
		if strings.ContainsAny(v.value, "'\n\r") {
			slog.Error("install script value cannot be quoted", "placeholder", v.name)
			return "", internalError("The install script is not available")
		}
		script = strings.ReplaceAll(script, "{{"+v.name+"}}", v.value)
	}
	return script, nil
}

func (a *App) installScript(w http.ResponseWriter, r *http.Request, template, os string) error {
	origin, ok := publicOrigin(a.Config, r.Host)
	if !ok {
		slog.Error("APP_URL is required to serve the client install scripts")
		return serviceUnavailable("The install script is not available")
	}
	releases, assets, err := a.loadReleases(r.Context(), true)
	if err != nil {
		return err
	}
	script, err := renderInstallScript(template, origin, releases, assets, os)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, script)
	return nil
}

// macosInstallScript: `/bin/zsh -c "$(curl -fsSL <origin>/api/client/install.sh)"`
func (a *App) macosInstallScript(w http.ResponseWriter, r *http.Request) error {
	return a.installScript(w, r, macosInstallScriptTemplate, "darwin")
}

// windowsInstallScript: `powershell … "irm -UseBasicParsing <origin>/api/client/install.ps1|iex"`
func (a *App) windowsInstallScript(w http.ResponseWriter, r *http.Request) error {
	return a.installScript(w, r, windowsInstallScriptTemplate, "windows")
}

// pickUpdate is a platform's update: the newest published release with a
// signed update bundle, or on Windows and Linux a signed installer, which is
// what their updates install (NSIS/MSI, AppImage). macOS updates replace the
// .app from its .app.tar.gz, never from the .dmg.
func pickUpdate(releases []ReleaseRow, assets []AssetRow, platform string) (*ReleaseRow, *AssetRow) {
	installerUpdates := !strings.HasPrefix(platform, "darwin-")
	for i := range releases {
		signed := func(kind string) *AssetRow {
			for j := range assets {
				asset := &assets[j]
				if asset.ReleaseID == releases[i].ID && asset.Platform == platform && asset.Kind == kind && asset.Signature != nil {
					return asset
				}
			}
			return nil
		}
		asset := signed("update")
		if asset == nil && installerUpdates {
			asset = signed("installer")
		}
		if asset != nil {
			return &releases[i], asset
		}
	}
	return nil, nil
}

// updateCheck is the Tauri updater's dynamic update server: 204 when the
// client is up to date, otherwise the newest signed update for its platform.
func (a *App) updateCheck(w http.ResponseWriter, r *http.Request) error {
	upToDate := func() error {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	platform := r.PathValue("target") + "-" + r.PathValue("arch")
	current, ok := parseSemver(r.PathValue("currentVersion"))
	if !ok {
		return upToDate()
	}
	if !slices.Contains(platforms, platform) {
		return upToDate()
	}
	releases, assets, err := a.loadReleases(r.Context(), true)
	if err != nil {
		return err
	}
	release, asset := pickUpdate(releases, assets, platform)
	if release == nil {
		return upToDate()
	}
	if releaseVersion(release).cmp(current) <= 0 {
		return upToDate()
	}
	origin, ok := publicOrigin(a.Config, r.Host)
	if !ok {
		slog.Error("APP_URL is required to serve client updates")
		return serviceUnavailable("Updates are not available")
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"version":   release.Version,
		"notes":     release.Notes,
		"pub_date":  isoStringOpt(release.PublishedAt),
		"url":       origin + downloadPath(asset),
		"signature": asset.Signature,
	})
	return nil
}

func contentDisposition(fileName string) string {
	var fallback strings.Builder
	for _, c := range fileName {
		if c >= ' ' && c <= '~' && c != '"' && c != '\\' {
			fallback.WriteRune(c)
		} else {
			fallback.WriteByte('_')
		}
	}
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, fallback.String(), encodePathSegment(fileName))
}

// releaseFileWriter adds the download headers to successful answers only
// (200 and 206), as the Rust handler does with ServeFile's response.
type releaseFileWriter struct {
	http.ResponseWriter
	fileName    string
	wroteHeader bool
}

func (w *releaseFileWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		if status >= 200 && status < 300 {
			header := w.Header()
			header.Set("Content-Type", "application/octet-stream")
			header.Set("Content-Disposition", contentDisposition(w.fileName))
			header.Set("Cache-Control", "public, max-age=31536000, immutable")
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *releaseFileWriter) Write(data []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

// downloadAsset serves files of published releases. Asset IDs are never
// reused, so responses can be cached for good; range and conditional
// requests (resumable downloads) and HEAD are answered as tower-http's
// ServeFile answers them.
func (a *App) downloadAsset(w http.ResponseWriter, r *http.Request) error {
	assetID, fileName := r.PathValue("assetId"), r.PathValue("fileName")
	asset, err := queryOptional[AssetRow](r.Context(), a.DB,
		`SELECT `+assetColumns+` FROM "ClientReleaseAsset" a JOIN "ClientRelease" r ON r.id = a."releaseId"
        WHERE a.id = $1 AND r."publishedAt" IS NOT NULL`, assetID)
	if err != nil {
		return dbError(err, "Failed to load client release file")
	}
	if asset == nil || asset.FileName != fileName {
		return notFound("File not found")
	}

	path := assetPath(a.Config, asset.ID)
	if _, err := os.Stat(path); err != nil {
		slog.Error("client release file is missing from storage", "asset_id", asset.ID)
		return notFound("File not found")
	}
	file, err := os.Open(path)
	if err != nil {
		return internalError("Failed to read file")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return internalError("Failed to read file")
	}
	if info.IsDir() {
		w.WriteHeader(http.StatusNotFound)
		return nil
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	// ServeFile knows only Range, If-Modified-Since and If-Unmodified-Since:
	// it has no entity tags and does not read If-Range.
	request := r.Clone(r.Context())
	request.Header.Del("If-Match")
	request.Header.Del("If-None-Match")
	request.Header.Del("If-Range")
	// ...and it serves one range at a time.
	if strings.Contains(request.Header.Get("Range"), ",") {
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Last-Modified", info.ModTime().UTC().Format(http.TimeFormat))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		_, _ = io.WriteString(w, "Cannot serve multipart range requests")
		return nil
	}
	http.ServeContent(&releaseFileWriter{ResponseWriter: w, fileName: asset.FileName}, request, "", info.ModTime(), file)
	return nil
}
