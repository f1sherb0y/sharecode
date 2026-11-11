package updates

import (
	"errors"
	"strings"
)

type semver struct {
	core [3]string
	pre  []string
}

func parseVersion(value string) (semver, error) {
	var result semver
	invalid := errors.New("invalid semantic version: " + value)
	if value == "" || strings.TrimSpace(value) != value {
		return result, invalid
	}
	base, build, hasBuild := strings.Cut(value, "+")
	if hasBuild && !validIdentifiers(build, false) {
		return result, invalid
	}
	main, pre, hasPre := strings.Cut(base, "-")
	parts := strings.Split(main, ".")
	if len(parts) != 3 {
		return result, invalid
	}
	for i, part := range parts {
		if !numeric(part) || (len(part) > 1 && part[0] == '0') {
			return result, invalid
		}
		result.core[i] = part
	}
	if hasPre {
		if !validIdentifiers(pre, true) {
			return result, invalid
		}
		result.pre = strings.Split(pre, ".")
	}
	return result, nil
}
func numeric(value string) bool {
	if value == "" {
		return false
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
func validIdentifiers(value string, prerelease bool) bool {
	for _, part := range strings.Split(value, ".") {
		if part == "" {
			return false
		}
		for _, ch := range part {
			if !(ch >= '0' && ch <= '9' || ch >= 'A' && ch <= 'Z' || ch >= 'a' && ch <= 'z' || ch == '-') {
				return false
			}
		}
		if prerelease && numeric(part) && len(part) > 1 && part[0] == '0' {
			return false
		}
	}
	return true
}
func compareNumeric(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

// CompareVersions implements SemVer 2.0 precedence without integer overflow.
// Build metadata is ignored; prereleases are older than the corresponding release.
func CompareVersions(a, b string) (int, error) {
	left, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	right, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := range left.core {
		if c := compareNumeric(left.core[i], right.core[i]); c != 0 {
			return c, nil
		}
	}
	if len(left.pre) == 0 && len(right.pre) == 0 {
		return 0, nil
	}
	if len(left.pre) == 0 {
		return 1, nil
	}
	if len(right.pre) == 0 {
		return -1, nil
	}
	for i := 0; i < len(left.pre) && i < len(right.pre); i++ {
		x, y := left.pre[i], right.pre[i]
		var c int
		switch {
		case numeric(x) && numeric(y):
			c = compareNumeric(x, y)
		case numeric(x):
			c = -1
		case numeric(y):
			c = 1
		default:
			c = strings.Compare(x, y)
		}
		if c != 0 {
			return c, nil
		}
	}
	if len(left.pre) < len(right.pre) {
		return -1, nil
	}
	if len(left.pre) > len(right.pre) {
		return 1, nil
	}
	return 0, nil
}
