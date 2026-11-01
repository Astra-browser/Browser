// Package classify loads the endpoint classification table
// (classify.toml: host -> KEEP/REPLACE/REMOVE) and answers lookups.
//
// TOML subset supported (stdlib-only, no external dep): comments with #,
// [[endpoint]] tables, and key = value pairs where values are double-quoted
// strings or booleans. Anything else is a parse error.
package classify

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Class is the disposition of an endpoint.
type Class string

const (
	Keep    Class = "KEEP"
	Replace Class = "REPLACE"
	Remove  Class = "REMOVE"
)

// Entry is one classified endpoint.
type Entry struct {
	Host         string
	Match        string // "exact" (default) or "suffix"
	Class        Class
	Reason       string
	Disable      string // pref/policy/build flag that kills it
	OwnerSignoff bool
	Source       string // engine path or doc URL evidencing it
}

// Table is the loaded classification.
type Table struct {
	Entries []Entry
}

// Load parses path.
func Load(path string) (*Table, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	t := &Table{}
	var cur *Entry
	lineno := 0
	flush := func() {
		if cur != nil {
			t.Entries = append(t.Entries, *cur)
			cur = nil
		}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		lineno++
		line = strings.TrimSpace(stripComment(line))
		if line == "" {
			continue
		}
		if line == "[[endpoint]]" {
			flush()
			cur = &Entry{Match: "exact"}
			continue
		}
		if cur == nil {
			return nil, fmt.Errorf("%s:%d: key=value outside [[endpoint]]", path, lineno)
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			return nil, fmt.Errorf("%s:%d: malformed line %q", path, lineno, line)
		}
		key := strings.TrimSpace(k)
		val, err := parseValue(strings.TrimSpace(v))
		if err != nil {
			return nil, fmt.Errorf("%s:%d: %w", path, lineno, err)
		}
		switch key {
		case "host":
			cur.Host = strings.ToLower(val)
		case "match":
			if val != "exact" && val != "suffix" {
				return nil, fmt.Errorf("%s:%d: bad match %q", path, lineno, val)
			}
			cur.Match = val
		case "class":
			switch Class(val) {
			case Keep, Replace, Remove:
				cur.Class = Class(val)
			default:
				return nil, fmt.Errorf("%s:%d: bad class %q", path, lineno, val)
			}
		case "reason":
			cur.Reason = val
		case "disable":
			cur.Disable = val
		case "source":
			cur.Source = val
		case "owner_signoff":
			b, err := strconv.ParseBool(val)
			if err != nil {
				return nil, fmt.Errorf("%s:%d: bad owner_signoff %q", path, lineno, val)
			}
			cur.OwnerSignoff = b
		default:
			return nil, fmt.Errorf("%s:%d: unknown key %q", path, lineno, key)
		}
	}
	flush()
	for i, e := range t.Entries {
		if e.Host == "" || e.Class == "" {
			return nil, fmt.Errorf("%s: entry %d missing host/class", path, i)
		}
	}
	return t, nil
}

func parseValue(v string) (string, error) {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		return strconv.Unquote(v)
	}
	if v == "true" || v == "false" {
		return v, nil
	}
	return "", fmt.Errorf("value must be \"string\" or bool, got %q", v)
}

func stripComment(line string) string {
	inStr := false
	for i := 0; i < len(line); i++ {
		switch line[i] {
		case '"':
			inStr = !inStr
		case '#':
			if !inStr {
				return line[:i]
			}
		}
	}
	return line
}

// Lookup returns the entry covering host, preferring exact over suffix.
func (t *Table) Lookup(host string) (Entry, bool) {
	host = strings.ToLower(host)
	var suffixHit *Entry
	for i := range t.Entries {
		e := &t.Entries[i]
		if e.Match == "exact" && host == e.Host {
			return *e, true
		}
		if e.Match == "suffix" && (host == e.Host || strings.HasSuffix(host, "."+e.Host)) {
			if suffixHit == nil {
				suffixHit = e
			} else if len(e.Host) > len(suffixHit.Host) {
				suffixHit = e // longest suffix wins
			}
		}
	}
	if suffixHit != nil {
		return *suffixHit, true
	}
	return Entry{}, false
}

// Gate checks phase hosts against the table; returns unclassified hosts.
// This is the CI gate: empty means pass.
func (t *Table) Gate(hosts []string) []string {
	var missing []string
	for _, h := range hosts {
		if _, ok := t.Lookup(h); !ok {
			missing = append(missing, h)
		}
	}
	return missing
}
