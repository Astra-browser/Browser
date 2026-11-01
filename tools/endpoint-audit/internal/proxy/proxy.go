// Package proxy implements a minimal forwarding HTTP(S) proxy that logs
// every outbound host. Plain-HTTP requests are forwarded with net/http;
// CONNECT tunnels (HTTPS) are spliced byte-for-byte after logging the
// target host:port. TLS is never terminated, so no CA install is needed
// and the audit stays fully passive.
package proxy

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Stat counts observations of one host.
type Stat struct {
	Count     int
	FirstSeen time.Time
	LastSeen  time.Time
	Methods   map[string]bool
}

// Logger is a forwarding proxy that records hosts.
type Logger struct {
	mu    sync.Mutex
	stats map[string]*Stat
	fwd   *http.Transport
	srv   *http.Server
	ln    net.Listener
}

// New starts the proxy on 127.0.0.1 with an ephemeral port.
func New() (*Logger, error) {
	l := &Logger{
		stats: make(map[string]*Stat),
		fwd:   &http.Transport{Proxy: nil},
	}
	l.srv = &http.Server{Handler: l}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	l.ln = ln
	go l.srv.Serve(ln) //nolint:errcheck // closed via Close
	return l, nil
}

// Addr returns the listener address (host:port).
func (l *Logger) Addr() string { return l.ln.Addr().String() }

// Close shuts the proxy down.
func (l *Logger) Close() error {
	l.fwd.CloseIdleConnections()
	return l.srv.Close()
}

func (l *Logger) record(host, method string) {
	host = strings.ToLower(host)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	s, ok := l.stats[host]
	if !ok {
		s = &Stat{FirstSeen: now, Methods: make(map[string]bool)}
		l.stats[host] = s
	}
	s.Count++
	s.LastSeen = now
	s.Methods[method] = true
}

// Hosts returns a snapshot of observed host statistics.
func (l *Logger) Hosts() map[string]Stat {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string]Stat, len(l.stats))
	for h, s := range l.stats {
		cp := *s
		out[h] = cp
	}
	return out
}

func (l *Logger) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		l.record(r.Host, "CONNECT")
		l.handleConnect(w, r)
		return
	}
	host := r.URL.Host
	if host == "" {
		host = r.Host
	}
	l.record(host, r.Method)
	l.handleForward(w, r)
}

func (l *Logger) handleForward(w http.ResponseWriter, r *http.Request) {
	out, err := http.NewRequest(r.Method, r.URL.String(), r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	out.Header = r.Header.Clone()
	resp, err := l.fwd.RoundTrip(out)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body) //nolint:errcheck // best effort
}

func (l *Logger) handleConnect(w http.ResponseWriter, r *http.Request) {
	target, err := net.DialTimeout("tcp", r.Host, 15*time.Second)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer target.Close()
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return
	}
	client, buf, err := hj.Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer client.Close()
	buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n") //nolint:errcheck
	buf.Flush()
	go io.Copy(target, client) //nolint:errcheck // tunnel
	io.Copy(client, target)    //nolint:errcheck // tunnel
}

// HostsFromLog scans MOZ_LOG necko output for outbound hostnames and
// returns the set found. It is a passive cross-check, not authoritative:
// the proxy log is the source of truth.
func HostsFromLog(logPath string) map[string]bool {
	found := make(map[string]bool)
	f, err := openFile(logPath)
	if err != nil {
		return found
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		for _, h := range extractHosts(sc.Text()) {
			found[strings.ToLower(h)] = true
		}
	}
	return found
}
