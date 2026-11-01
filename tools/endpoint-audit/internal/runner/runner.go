// Package runner launches the browser binary headless against a fresh
// profile: first an idle soak (about:blank), then one process per
// scripted URL. MOZ_LOG necko output is collected as a cross-check.
package runner

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// Options controls a run.
type Options struct {
	Binary   string
	Profile  string
	LogFile  string
	Headless bool
	Env      []string
}

// Run launches the binary with args, waits for d, then kills it.
// Missing binary is an error; the caller decides fallback messaging.
func Run(opts Options, args []string, d time.Duration) error {
	if _, err := os.Stat(opts.Binary); err != nil {
		return fmt.Errorf("binary not found: %s: %w", opts.Binary, err)
	}
	cmd := exec.Command(opts.Binary, args...)
	if opts.Headless {
		cmd.Args = append(cmd.Args, "--headless")
	}
	cmd.Env = append(os.Environ(), opts.Env...)
	if opts.LogFile != "" {
		f, err := os.Create(opts.LogFile)
		if err != nil {
			return err
		}
		defer f.Close()
		cmd.Stdout = f
		cmd.Stderr = f
		lf, _ := filepath.Abs(opts.LogFile)
		_ = lf
	}
	// MOZ_LOG file backend: "Module:5,Other:5" + MOZ_LOG_FILE path.
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
		return nil // exited on its own (e.g. --screenshot loads)
	case <-time.After(d):
		_ = cmd.Process.Kill()
		<-done
		return nil
	}
}

// Idle Soaks about:blank for d.
func Idle(opts Options, d time.Duration) error {
	args := []string{"--profile", opts.Profile, "--no-remote", "about:blank"}
	return Run(opts, args, d)
}

// Visit loads url headless and kills the process after d.
func Visit(opts Options, url string, d time.Duration) error {
	args := []string{"--profile", opts.Profile, "--no-remote", url}
	return Run(opts, args, d)
}

// LogEnv returns MOZ_LOG env entries writing necko logs to logFile.
func LogEnv(logFile string) []string {
	return []string{
		"MOZ_LOG=nsHttp:5,nsSocketTransport:5,nsHostResolver:5",
		"MOZ_LOG_FILE=" + logFile,
	}
}
