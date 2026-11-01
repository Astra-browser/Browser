# endpoint-audit

Captures every outbound host a browser build contacts (idle soak, then
scripted browsing), classifies each via `classify.toml`, and exits 1 when
an **unclassified host was observed at idle** (the P1-T07 CI gate).

Go 1.27, stdlib-only (no external deps — the TOML subset parser in
`internal/classify` covers exactly our schema; see `classify.toml`).

## Usage

The tool is its own Go module (`go.mod` = `astra-endpoint-audit`), so run
it from its directory (or `go -C tools/endpoint-audit ...`):

```sh
cd tools/endpoint-audit
go run . --help

# Full audit against the built Astra binary:
go run . \
  --binary ../../engine/obj-astra-linux/dist/bin/firefox \
  --idle 10m \
  --script-urls "https://example.com,https://example.org" \
  --out ../../out/endpoint-audit

# Fast check (tests / CI smoke):
go run . \
  --binary ../../engine/obj-astra-linux/dist/bin/firefox \
  --idle 30s --per-url-timeout 15s

# Offline: classify a host list without launching anything:
go run . --no-run \
  --hosts "shavar.services.mozilla.com,evil.example.net"

# Fallback when no Astra build exists: point --binary at stock firefox.
```

Flags: `--classify` (default `tools/endpoint-audit/classify.toml`),
`--headless` (default true), `--no-run` + `--hosts`.

## Layout

- `main.go` — flag parsing, phase orchestration, gate exit code.
- `internal/profile` — fresh temp profile with proxy wired via `user.js`.
- `internal/proxy` — forwarding HTTP(S) proxy logging every host
  (CONNECT targets for HTTPS; no TLS termination) + MOZ_LOG parser.
- `internal/runner` — headless idle soak + per-URL scripted visits.
- `internal/classify` — `classify.toml` loader, exact/suffix lookup, gate.
- `internal/report` — JSON + Markdown writers.
- `classify.toml` — host → KEEP/REPLACE/REMOVE + kill switch + evidence.
  Every `owner_signoff=false` entry needs owner review.

## Tests

```sh
cd tools/endpoint-audit && go test ./...   # unit: classifier, proxy, gate, runner
go vet ./...                                # clean
```
