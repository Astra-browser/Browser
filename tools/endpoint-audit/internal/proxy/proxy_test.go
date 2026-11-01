package proxy

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"testing"
)

func TestHTTPForwardAndLog(t *testing.T) {
	backend := http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintln(w, "hello")
	})}
	bln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer bln.Close()
	go backend.Serve(bln) //nolint:errcheck

	px, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer px.Close()
	pu, _ := url.Parse("http://" + px.Addr())
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(pu)}}

	resp, err := client.Get("http://" + bln.Addr().String() + "/page")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "hello\n" {
		t.Fatalf("bad body %q", body)
	}
	hosts := px.Hosts()
	if len(hosts) != 1 {
		t.Fatalf("want 1 host, got %v", hosts)
	}
	for h, s := range hosts {
		if h != "127.0.0.1" || s.Count != 1 {
			t.Fatalf("unexpected stat %+v", s)
		}
		if !s.Methods["GET"] {
			t.Fatalf("method not recorded: %+v", s.Methods)
		}
	}
}

func TestConnectLogged(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	go func() {
		for {
			c, err := target.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()

	px, err := New()
	if err != nil {
		t.Fatal(err)
	}
	defer px.Close()

	c, err := net.Dial("tcp", px.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	fmt.Fprintf(c, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", target.Addr().String(), target.Addr().String())
	buf := make([]byte, 64)
	n, err := c.Read(buf)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf[:n]) != "HTTP/1.1 200 Connection Established\r\n\r\n" {
		t.Fatalf("bad connect reply %q", buf[:n])
	}
	hosts := px.Hosts()
	if len(hosts) != 1 {
		t.Fatalf("want 1 host, got %v", hosts)
	}
	for h, s := range hosts {
		if h != "127.0.0.1" || !s.Methods["CONNECT"] {
			t.Fatalf("unexpected stat %q %+v", h, s)
		}
	}
}

func TestHostsFromLog(t *testing.T) {
	f, err := os.CreateTemp("", "necko-*.log")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(f.Name())
	fmt.Fprintln(f, "[Parent 1234: nsHttp] HttpChannel creating https://contile.services.mozilla.com/v1/tiles foo")
	fmt.Fprintln(f, "[Parent 1234: nsSocketTransport] CONNECT shavar.services.mozilla.com:443 bar")
	fmt.Fprintln(f, "Host: incoming.telemetry.mozilla.org baz")
	fmt.Fprintln(f, "noise without hosts 12345")
	f.Close()
	found := HostsFromLog(f.Name())
	for _, want := range []string{"contile.services.mozilla.com", "shavar.services.mozilla.com", "incoming.telemetry.mozilla.org"} {
		if !found[want] {
			t.Fatalf("missing %q in %v", want, found)
		}
	}
	if len(found) != 3 {
		t.Fatalf("over-matched: %v", found)
	}
	if len(HostsFromLog(f.Name()+".nonexistent")) != 0 {
		t.Fatal("missing file should yield empty set")
	}
}
