package updates

import "testing"

func TestSemanticVersionPrecedence(t *testing.T) {
	ordered := []string{"0.2.7", "0.2.8-alpha", "0.2.8-alpha.1", "0.2.8-alpha.beta", "0.2.8-beta", "0.2.8-beta.2", "0.2.8-beta.11", "0.2.8-rc.1", "0.2.8", "0.2.10", "1.0.0", "999999999999999999999999999999.0.0"}
	for i := range ordered {
		for j := range ordered {
			got, err := CompareVersions(ordered[i], ordered[j])
			if err != nil {
				t.Fatal(err)
			}
			if i < j && got >= 0 || i == j && got != 0 || i > j && got <= 0 {
				t.Fatalf("%s vs %s: %d", ordered[i], ordered[j], got)
			}
		}
	}
	if got, err := CompareVersions("1.0.0+build.001", "1.0.0+other"); err != nil || got != 0 {
		t.Fatalf("build metadata: %d %v", got, err)
	}
}
func TestInvalidVersionsFailClosed(t *testing.T) {
	for _, version := range []string{"", "1", "1.2", "01.2.3", "1.02.3", "1.2.03", "v1.2.3", "1.2.3-", "1.2.3-01", "1.2.3+", "1.2.3+a..b", "1.2.3+a+b", " 1.2.3", "1.2.3\n", "1.2.3-中文"} {
		if _, err := CompareVersions(version, "0.2.7"); err == nil {
			t.Fatalf("accepted %q", version)
		}
	}
}
