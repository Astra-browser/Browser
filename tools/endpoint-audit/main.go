// Command endpoint-audit captures every outbound host a browser build
// contacts: first during a configurable idle soak (default 10m), then
// during scripted browsing of --script-urls. Hosts are classified via
// classify.toml; exit code is 1 when an unclassified host was observed
// at idle (the CI gate).
//
// Capture is passive and needs no root: a stdlib forwarding proxy on
// 127.0.0.1 logs every host (CONNECT targets for HTTPS, full URLs for
// HTTP) and is wired in through a fresh temp profile's user.js; MOZ_LOG
// necko output is collected as a cross-check.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"astra-endpoint-audit/internal/classify"
	"astra-endpoint-audit/internal/profile"
	"astra-endpoint-audit/internal/proxy"
	"astra-endpoint-audit/internal/report"
	"astra-endpoint-audit/internal/runner"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "endpoint-audit:", err)
		os.Exit(2)
	}
}

func run() error {
	binary := flag.String("binary", "", "browser binary to audit (required)")
	idle := flag.Duration("idle", 10*time.Minute, "idle soak duration (e.g. 30s for tests)")
	scriptURLs := flag.String("script-urls", "", "comma-separated URLs for scripted browsing")
	perURL := flag.Duration("per-url-timeout", 30*time.Second, "time to spend on each script URL")
	classifyPath := flag.String("classify", "tools/endpoint-audit/classify.toml", "classification table")
	out := flag.String("out", "out/endpoint-audit", "output directory (captures + profiles)")
	noRun := flag.Bool("no-run", false, "skip launching the browser; classify hosts from --hosts")
	hostsFlag := flag.String("hosts", "", "comma-separated hosts to classify (with --no-run)")
	headless := flag.Bool("headless", true, "launch browser headless")
	flag.Parse()

	if *binary == "" && !*noRun {
		return fmt.Errorf("--binary is required (or --no-run for offline classification)")
	}
	table, err := classify.Load(*classifyPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(*out, "captures"), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(*out, "profiles"), 0o755); err != nil {
		return err
	}

	phase := map[string]map[string]bool{} // host -> phases seen
	counts := map[string]int{}
	sources := map[string]map[string]bool{}

	mark := func(host, ph, src string, n int) {
		host = strings.ToLower(host)
		if phase[host] == nil {
			phase[host] = map[string]bool{}
		}
		phase[host][ph] = true
		counts[host] += n
		if sources[host] == nil {
			sources[host] = map[string]bool{}
		}
		sources[host][src] = true
	}

	var urls []string
	if *scriptURLs != "" {
		for _, u := range strings.Split(*scriptURLs, ",") {
			if u = strings.TrimSpace(u); u != "" {
				urls = append(urls, u)
			}
		}
	}

	if *noRun {
		for _, h := range strings.Split(*hostsFlag, ",") {
			if h = strings.TrimSpace(strings.ToLower(h)); h != "" {
				mark(h, "idle", "manual", 1)
			}
		}
	} else {
		px, err := proxy.New()
		if err != nil {
			return err
		}
		defer px.Close()
		prof, err := profile.Create(filepath.Join(*out, "profiles"), profile.Options{ProxyAddr: px.Addr()})
		if err != nil {
			return err
		}
		logFile := filepath.Join(*out, "captures", "necko.log")
		opts := runner.Options{
			Binary:   *binary,
			Profile:  prof,
			LogFile:  logFile,
			Headless: *headless,
			Env:      runner.LogEnv(logFile + ".mozlog"),
		}
		fmt.Printf("idle soak %s (profile %s, proxy %s)\n", (*idle).String(), prof, px.Addr())
		if err := runner.Idle(opts, *idle); err != nil {
			return err
		}
		for h, s := range px.Hosts() {
			mark(h, "idle", "proxy", s.Count)
		}
		for h := range proxy.HostsFromLog(logFile + ".mozlog") {
			mark(h, "idle", "mozlog", 0)
		}
		for _, u := range urls {
			fmt.Printf("scripted visit %s\n", u)
			if err := runner.Visit(opts, u, *perURL); err != nil {
				return err
			}
		}
		for h, s := range px.Hosts() {
			if !phase[h]["idle"] {
				mark(h, "scripted", "proxy", s.Count)
			} else {
				counts[h] = s.Count
			}
		}
	}

	// Build result.
	res := report.Result{
		GeneratedAt:  report.Now(),
		Binary:       *binary,
		IdleDuration: (*idle).String(),
		ScriptURLs:   urls,
	}
	var idleHosts []string
	for h, ph := range phase {
		var phases []string
		for p := range ph {
			phases = append(phases, p)
		}
		sort.Strings(phases)
		var srcs []string
		for s := range sources[h] {
			srcs = append(srcs, s)
		}
		sort.Strings(srcs)
		rec := report.HostRecord{
			Host: h, Phase: strings.Join(phases, "+"),
			Count: counts[h], Sources: srcs,
		}
		if e, ok := table.Lookup(h); ok {
			rec.Class = string(e.Class)
			rec.Reason = e.Reason
			rec.Disable = e.Disable
			rec.Signoff = e.OwnerSignoff
		}
		res.Hosts = append(res.Hosts, rec)
		if ph["idle"] {
			idleHosts = append(idleHosts, h)
		}
	}
	sort.Strings(idleHosts)
	res.Unclassified = table.Gate(idleHosts)
	if res.Unclassified == nil {
		res.Unclassified = []string{}
	}
	res.GatePass = len(res.Unclassified) == 0

	ts := time.Now().UTC().Format("20060102-150405")
	if err := report.WriteJSON(filepath.Join(*out, "captures", "audit-"+ts+".json"), res); err != nil {
		return err
	}
	if err := report.WriteMarkdown(filepath.Join(*out, "captures", "audit-"+ts+".md"), res); err != nil {
		return err
	}
	fmt.Printf("hosts: %d (idle %d) · gate: %s\n", len(res.Hosts), len(idleHosts),
		map[bool]string{true: "PASS", false: "FAIL"}[res.GatePass])
	for _, h := range res.Unclassified {
		fmt.Printf("unclassified-at-idle: %s\n", h)
	}
	if !res.GatePass {
		os.Exit(1)
	}
	return nil
}
