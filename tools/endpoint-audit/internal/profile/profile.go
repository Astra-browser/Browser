// Package profile creates and manages fresh temporary Firefox/Astra profiles
// for endpoint-audit runs. The profile wires the audit proxy in via
// user.js prefs so no root privileges or binary-dir writes are needed.
package profile

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
)

// Options controls profile creation.
type Options struct {
	// ProxyAddr is host:port of the audit logging proxy (127.0.0.1:port).
	ProxyAddr string
}

// Create makes a fresh profile directory under base and writes user.js.
// It returns the profile directory path.
func Create(base string, opts Options) (string, error) {
	host, port, err := net.SplitHostPort(opts.ProxyAddr)
	if err != nil {
		return "", fmt.Errorf("bad proxy addr %q: %w", opts.ProxyAddr, err)
	}
	dir, err := os.MkdirTemp(base, "audit-profile-")
	if err != nil {
		return "", err
	}
	js := "user_pref(\"network.proxy.type\", 1);\n" +
		"user_pref(\"network.proxy.http\", \"" + host + "\");\n" +
		"user_pref(\"network.proxy.http_port\", " + port + ");\n" +
		"user_pref(\"network.proxy.ssl\", \"" + host + "\");\n" +
		"user_pref(\"network.proxy.ssl_port\", " + port + ");\n" +
		"user_pref(\"network.proxy.share_proxy_settings\", true);\n" +
		"user_pref(\"network.proxy.no_proxies_on\", \"\");\n" +
		// Quiet first-run surfaces so the capture reflects background
		// traffic, not onboarding pages.
		"user_pref(\"browser.startup.homepage\", \"about:blank\");\n" +
		"user_pref(\"startup.homepage_welcome_url\", \"about:blank\");\n" +
		"user_pref(\"browser.aboutwelcome.enabled\", false);\n" +
		"user_pref(\"datareporting.policy.dataSubmissionEnabled\", false);\n"
	if err := os.WriteFile(filepath.Join(dir, "user.js"), []byte(js), 0o600); err != nil {
		return "", err
	}
	return dir, nil
}
