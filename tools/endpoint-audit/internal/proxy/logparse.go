package proxy

import (
	"os"
	"regexp"
)

func openFile(path string) (*os.File, error) { return os.Open(path) }

// Matches http(s)://host and "Host: host" fragments in necko logs.
var (
	urlHostRe  = regexp.MustCompile(`https?://([A-Za-z0-9._~-]+)(?::\d+)?(?:[/\s"'])`)
	hostHdrRe  = regexp.MustCompile(`(?i)\bhost:\s*([A-Za-z0-9._~-]+)`)
	connectRe  = regexp.MustCompile(`(?i)\bCONNECT\s+([A-Za-z0-9._~-]+)(?::\d+)?`)
	ignoreBare = map[string]bool{"http": true, "https": true}
)

func extractHosts(line string) []string {
	var out []string
	seen := map[string]bool{}
	add := func(h string) {
		h = trimDot(h)
		if h == "" || ignoreBare[h] || seen[h] {
			return
		}
		if !looksHost(h) {
			return
		}
		seen[h] = true
		out = append(out, h)
	}
	for _, m := range urlHostRe.FindAllStringSubmatch(line, -1) {
		add(m[1])
	}
	for _, m := range hostHdrRe.FindAllStringSubmatch(line, -1) {
		add(m[1])
	}
	for _, m := range connectRe.FindAllStringSubmatch(line, -1) {
		add(m[1])
	}
	return out
}

func trimDot(h string) string {
	for len(h) > 0 && h[0] == '.' {
		h = h[1:]
	}
	return h
}

func looksHost(h string) bool {
	// Must contain a dot or be localhost; skip single tokens and
	// all-numeric fragments from log noise.
	hasDot := false
	hasAlpha := false
	for _, c := range h {
		switch {
		case c == '.':
			hasDot = true
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_' || c == '~':
			hasAlpha = true
		case c >= '0' && c <= '9':
		default:
			return false
		}
	}
	return hasAlpha && (hasDot || h == "localhost")
}
