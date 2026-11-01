package classify

import (
	"os"
	"path/filepath"
	"testing"
)

const goodTOML = `
[[endpoint]]
host = "example.com"
class = "KEEP"
reason = "test"
disable = ""
owner_signoff = true
source = "test"

[[endpoint]]
host = "mozilla.com"
match = "suffix"
class = "REMOVE"
reason = "suffix test"
disable = "pref x"
owner_signoff = false
source = "test"
`

func writeTemp(t *testing.T, s string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "classify.toml")
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestLoadAndLookup(t *testing.T) {
	tab, err := Load(writeTemp(t, goodTOML))
	if err != nil {
		t.Fatal(err)
	}
	if len(tab.Entries) != 2 {
		t.Fatalf("want 2 entries, got %d", len(tab.Entries))
	}
	e, ok := tab.Lookup("example.com")
	if !ok || e.Class != Keep || !e.OwnerSignoff {
		t.Fatalf("exact lookup failed: %+v %v", e, ok)
	}
	e, ok = tab.Lookup("sub.mozilla.com")
	if !ok || e.Class != Remove {
		t.Fatalf("suffix lookup failed: %+v %v", e, ok)
	}
	if _, ok := tab.Lookup("unknown.example.org"); ok {
		t.Fatal("unknown host should not match")
	}
}

func TestLongestSuffixWins(t *testing.T) {
	tab, err := Load(writeTemp(t, `
[[endpoint]]
host = "services.mozilla.com"
match = "suffix"
class = "REMOVE"
reason = "r"
disable = ""
owner_signoff = false
source = "t"
[[endpoint]]
host = "shavar.services.mozilla.com"
match = "exact"
class = "KEEP"
reason = "k"
disable = ""
owner_signoff = false
source = "t"
`))
	if err != nil {
		t.Fatal(err)
	}
	e, ok := tab.Lookup("shavar.services.mozilla.com")
	if !ok || e.Class != Keep {
		t.Fatalf("exact should beat suffix: %+v %v", e, ok)
	}
	e, ok = tab.Lookup("other.services.mozilla.com")
	if !ok || e.Class != Remove {
		t.Fatalf("suffix should match: %+v %v", e, ok)
	}
}

func TestLoadRejects(t *testing.T) {
	for name, doc := range map[string]string{
		"bad class":   "[[endpoint]]\nhost = \"x\"\nclass = \"MAYBE\"\n",
		"unknown key": "[[endpoint]]\nhost = \"x\"\nclass = \"KEEP\"\nbogus = 1\n",
		"no table":    "host = \"x\"\n",
		"missing":     "[[endpoint]]\nhost = \"x\"\n",
		"bad match":   "[[endpoint]]\nhost = \"x\"\nmatch = \"regex\"\nclass = \"KEEP\"\n",
	} {
		if _, err := Load(writeTemp(t, doc)); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}

func TestGate(t *testing.T) {
	tab, err := Load(writeTemp(t, goodTOML))
	if err != nil {
		t.Fatal(err)
	}
	if got := tab.Gate([]string{"example.com", "a.mozilla.com"}); len(got) != 0 {
		t.Fatalf("want pass, got %v", got)
	}
	got := tab.Gate([]string{"example.com", "evil.example.net"})
	if len(got) != 1 || got[0] != "evil.example.net" {
		t.Fatalf("want [evil.example.net], got %v", got)
	}
}

func TestSeedTableLoads(t *testing.T) {
	tab, err := Load("../../classify.toml")
	if err != nil {
		t.Fatal(err)
	}
	if len(tab.Entries) == 0 {
		t.Fatal("seed table is empty")
	}
	// Every entry must carry evidence.
	for _, e := range tab.Entries {
		if e.Reason == "" || e.Source == "" {
			t.Fatalf("entry %q lacks reason/source", e.Host)
		}
	}
	// Security-critical anchors must be present with the right class.
	for host, want := range map[string]Class{
		"shavar.services.mozilla.com":    Keep,
		"detectportal.firefox.com":       Remove,
		"incoming.telemetry.mozilla.org": Remove,
		"aus5.mozilla.org":               Replace,
	} {
		e, ok := tab.Lookup(host)
		if !ok || e.Class != want {
			t.Fatalf("lookup %q: got %+v %v, want class %s", host, e, ok, want)
		}
	}
}
