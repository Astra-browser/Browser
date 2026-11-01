package runner

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fakeBinary(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "fakebrowser.sh")
	script := "#!/bin/sh\nsleep 30\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunKillsAfterDuration(t *testing.T) {
	start := time.Now()
	err := Run(Options{Binary: fakeBinary(t), Headless: false}, []string{"--profile", "x"}, 300*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("run did not kill process promptly: %s", elapsed)
	}
}

func TestRunMissingBinary(t *testing.T) {
	if err := Run(Options{Binary: "/nonexistent/binary"}, nil, time.Second); err == nil {
		t.Fatal("expected error for missing binary")
	}
}

func TestLogEnv(t *testing.T) {
	env := LogEnv("/tmp/x.mozlog")
	if len(env) != 2 {
		t.Fatalf("want 2 env entries, got %v", env)
	}
}
