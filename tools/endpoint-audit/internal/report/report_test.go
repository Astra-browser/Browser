package report

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sample(pass bool) Result {
	r := Result{
		GeneratedAt: "2026-11-02T00:00:00Z", Binary: "/bin/fake",
		IdleDuration: "30s",
		Hosts: []HostRecord{
			{Host: "shavar.services.mozilla.com", Phase: "idle", Count: 3, Sources: []string{"proxy"}, Class: "KEEP", Signoff: false},
		},
		Unclassified: []string{},
		GatePass:     true,
	}
	if !pass {
		r.Unclassified = []string{"evil.example.net"}
		r.Hosts = append(r.Hosts, HostRecord{Host: "evil.example.net", Phase: "idle", Count: 1, Sources: []string{"proxy"}})
		r.GatePass = false
	}
	return r
}

func TestWriters(t *testing.T) {
	for _, pass := range []bool{true, false} {
		dir := t.TempDir()
		jp := filepath.Join(dir, "audit.json")
		mp := filepath.Join(dir, "audit.md")
		if err := WriteJSON(jp, sample(pass)); err != nil {
			t.Fatal(err)
		}
		if err := WriteMarkdown(mp, sample(pass)); err != nil {
			t.Fatal(err)
		}
		raw, _ := os.ReadFile(jp)
		var back Result
		if err := json.Unmarshal(raw, &back); err != nil {
			t.Fatal(err)
		}
		if back.GatePass != pass {
			t.Fatalf("round-trip gate mismatch: %v", back.GatePass)
		}
		md, _ := os.ReadFile(mp)
		want := map[bool]string{true: "PASS", false: "FAIL"}[pass]
		if !strings.Contains(string(md), want) {
			t.Fatalf("markdown missing %q", want)
		}
		if !pass && !strings.Contains(string(md), "evil.example.net") {
			t.Fatal("markdown missing unclassified host")
		}
	}
}
