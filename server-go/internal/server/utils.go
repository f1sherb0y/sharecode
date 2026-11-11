package server

import (
	_ "embed"
	"fmt"
	"math"
	"math/rand/v2"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

// --- colours (utils/colors.rs) ---

var userColors = []string{"#30bced", "#6eeb83", "#ffbc42", "#ecd444", "#ee6352", "#9ac2c9", "#8acb88", "#1be7ff"}

// SessionColor is the colour of one connection in a room.
type SessionColor struct {
	Slot       int
	Color      string
	ColorLight string
}

func randomUserColor() string { return userColors[rand.IntN(len(userColors))] }

// nextAvailableColorSlot is the lowest slot not in use.
func nextAvailableColorSlot(used []int) int {
	taken := map[int]bool{}
	for _, slot := range used {
		taken[slot] = true
	}
	slot := 0
	for taken[slot] {
		slot++
	}
	return slot
}

func sessionColorForSlot(slot int) SessionColor {
	hue := int(math.Round(float64(slot)*137.508)) % 360
	saturations := []int{78, 72, 84, 68}
	lightnesses := []int{52, 46, 58, 64}
	saturation := saturations[(slot/360)%len(saturations)]
	lightness := lightnesses[(slot/(360*len(saturations)))%len(lightnesses)]
	lightLightness := min(lightness+18, 72)
	return SessionColor{
		Slot:       slot,
		Color:      fmt.Sprintf("hsl(%d, %d%%, %d%%)", hue, saturation, lightness),
		ColorLight: fmt.Sprintf("hsla(%d, %d%%, %d%%, 0.5)", hue, saturation, lightLightness),
	}
}

// --- passwords (utils/passwords.rs) ---

const minPasswordLength = 10

const passwordPolicyMessage = "Password must be at least 10 characters long, include uppercase and lowercase letters, a number, and a special character, must not contain spaces, and must not be a common password"

//go:embed dicts/common_passwords_len10_cls4.txt
var commonPasswordsFile string

var commonPasswords = sync.OnceValue(func() map[string]struct{} {
	out := map[string]struct{}{}
	for _, line := range strings.Split(commonPasswordsFile, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			out[strings.ToLower(line)] = struct{}{}
		}
	}
	return out
})

// validatePassword returns the policy message for a password that does not
// satisfy it, "" for one that does.
func validatePassword(password string) string {
	if utf8.RuneCountInString(password) < minPasswordLength {
		return passwordPolicyMessage
	}
	var upper, lower, digit, special bool
	for _, ch := range password {
		switch {
		case unicode.IsSpace(ch):
			return passwordPolicyMessage
		case ch >= 'A' && ch <= 'Z':
			upper = true
		case ch >= 'a' && ch <= 'z':
			lower = true
		case ch >= '0' && ch <= '9':
			digit = true
		default:
			special = true
		}
	}
	if !upper || !lower || !digit || !special {
		return passwordPolicyMessage
	}
	if _, common := commonPasswords()[strings.ToLower(password)]; common {
		return passwordPolicyMessage
	}
	return ""
}

// --- usernames (utils/usernames.rs) ---

// maxUsernameChars is the longest username, in characters.
const maxUsernameChars = 32

const invalidUsername = "A username of 2 to 32 characters without spaces is required"

// normalizeUsername gives the form every new or changed username takes: no
// surrounding spaces, 2 to 32 characters, no spaces or control characters
// inside. ok is false for a name that cannot take it.
func normalizeUsername(raw string) (name string, ok bool) {
	name = strings.TrimSpace(raw)
	length := utf8.RuneCountInString(name)
	if length < 2 || length > maxUsernameChars || strings.ContainsFunc(name, func(c rune) bool {
		return unicode.IsSpace(c) || unicode.IsControl(c)
	}) {
		return "", false
	}
	return name, true
}
