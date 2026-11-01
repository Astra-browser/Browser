package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreate(t *testing.T) {
	dir, err := Create(t.TempDir(), Options{ProxyAddr: "127.0.0.1:18080"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "user.js"))
	if err != nil {
		t.Fatal(err)
	}
	js := string(raw)
	for _, want := range []string{
		"network.proxy.type\", 1",
		"network.proxy.ssl\", \"127.0.0.1\"",
		"network.proxy.ssl_port\", 18080",
		"about:blank",
	} {
		if !strings.Contains(js, want) {
			t.Fatalf("user.js missing %q:\n%s", want, js)
		}
	}
}

func TestCreateBadProxy(t *testing.T) {
	if _, err := Create(t.TempDir(), Options{ProxyAddr: "not-an-addr"}); err == nil {
		t.Fatal("expected error for bad proxy addr")
	}
}
