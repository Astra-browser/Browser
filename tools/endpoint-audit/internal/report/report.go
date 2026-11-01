// Package report writes machine-readable (JSON) and human-readable
// (Markdown) audit results.
package report

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// HostRecord is one observed host in the report.
type HostRecord struct {
	Host      string   `json:"host"`
	Phase     string   `json:"phase"` // idle, scripted
	Count     int      `json:"count"`
	FirstSeen string   `json:"first_seen"`
	LastSeen  string   `json:"last_seen"`
	Sources   []string `json:"sources"` // proxy, mozlog
	Class     string   `json:"class,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	Disable   string   `json:"disable,omitempty"`
	Signoff   bool     `json:"owner_signoff,omitempty"`
}

// Result is the full audit result.
type Result struct {
	GeneratedAt  string       `json:"generated_at"`
	Binary       string       `json:"binary"`
	IdleDuration string       `json:"idle_duration"`
	ScriptURLs   []string     `json:"script_urls"`
	Hosts        []HostRecord `json:"hosts"`
	Unclassified []string     `json:"unclassified_at_idle"`
	GatePass     bool         `json:"gate_pass"`
}

// WriteJSON writes result to path.
func WriteJSON(path string, r Result) error {
	raw, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o644)
}

// WriteMarkdown writes the human-readable table to path.
func WriteMarkdown(path string, r Result) error {
	var b strings.Builder
	b.WriteString("# Endpoint audit\n\n")
	b.WriteString(fmt.Sprintf("Generated: %s\n\n", r.GeneratedAt))
	b.WriteString(fmt.Sprintf("Binary: `%s` · idle soak: %s\n\n", r.Binary, r.IdleDuration))
	b.WriteString("## Hosts\n\n")
	b.WriteString("| Host | Phase | Count | Sources | Class | Disable | Sign-off |\n")
	b.WriteString("|---|---|---|---|---|---|---|\n")
	hosts := append([]HostRecord(nil), r.Hosts...)
	sort.Slice(hosts, func(i, j int) bool { return hosts[i].Host < hosts[j].Host })
	for _, h := range hosts {
		fmt.Fprintf(&b, "| %s | %s | %d | %s | %s | %s | %v |\n",
			h.Host, h.Phase, h.Count, strings.Join(h.Sources, ","),
			h.Class, h.Disable, h.Signoff)
	}
	b.WriteString("\n## Gate\n\n")
	if r.GatePass {
		b.WriteString("PASS: every host observed at idle is classified.\n")
	} else {
		b.WriteString("FAIL: unclassified hosts at idle:\n\n")
		for _, h := range r.Unclassified {
			fmt.Fprintf(&b, "- %s\n", h)
		}
	}
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

func Now() string { return time.Now().UTC().Format(time.RFC3339) }
