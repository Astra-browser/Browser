# U-01 decision: sidecar transport — stdio (Subprocess) vs loopback WebSocket

Status: spike complete (P1-T09). Recommendation: **stdio via Subprocess**;
loopback WebSocket kept as documented fallback only.

## Question

Can the Gecko host spawn `astra-core` and hold sustained, framed,
crash-recoverable IPC over stdio on all 3 OSes — or must we fall back to a
loopback WebSocket?

## Method

- Researched the real API surface first, no guessing:
  - `firefox-source-docs` Subprocess module page (via Firecrawl scrape):
    `Subprocess.call` → `Process`; stdin/stdout always piped; stderr
    inheritable/mergeable/pipable; exact-length reads; deadlock rules for
    bidirectional IO; AsyncShutdown kill-blocker pattern.
  - Pinned ESR source (read directly, `engine/toolkit/modules/subprocess/`):
    `Subprocess.sys.mjs:109-150` (`call({command, arguments, environment,
    environmentAppend, stderr, workdir, disclaim})`; absolute path required;
    `ERROR_BAD_EXECUTABLE`); `subprocess_common.sys.mjs` (`OutputPipe.write`
    takes `ArrayBuffer|TypedArray|string`, binary-safe; `InputPipe.read(n)`,
    `readString`, `readJSON`, `readUint32` **native byte order** — so our BE
    length prefix must use `read(4)`+`DataView`, never `readUint32`;
    `kill(timeout)` SIGTERM-then-SIGKILL on unixes, force on Windows;
    `wait()` → `{exitCode}`); `subprocess_unix.sys.mjs` vs
    `subprocess_win.sys.mjs` backends; `disclaim` is macOS-only.
  - Context7 Rust std docs: `read_exact`/`write_all`/`flush` semantics used
    by the stub.
- Prototype (this branch):
  - `crates/astra-proto/` — stdlib-only Rust echo core speaking Appendix C
    frames (4-byte BE + UTF-8 JSON envelope `{v,id,kind,name,seq,payload,
    error}`); EOF → exit 0; `core.shutdown` → reply then exit 0.
  - `overlay/astra/host/BootSidecar.sys.mjs` — chrome-side launcher on the
    verified Subprocess API (not yet in `jar.mn`; P2 packaging owns that).
  - `tests/contract/sidecar_spike.mjs` — stdlib-only Node harness mirroring
    the chrome framing logic: 2000 sequential round-trips, 1000-msg burst at
    50 in flight, SIGTERM kill + respawn, browser-death (pipe close → EOF),
    plus a hand-rolled stdlib WS server (random port, per-launch token in
    query, 401 on mismatch) for the fallback comparison.
- NOT measured here: real Firefox-process spawn (needs built browser; P2
  wires `BootSidecar` into startup and re-runs this harness), Windows/macOS
  (Linux only on this worker; per-OS notes below cover the known deltas).

## Results (Linux, 3 runs, `node tests/contract/sidecar_spike.mjs` → SPIKE PASS)

| Metric | stdio | loopback WS |
|---|---|---|
| Sequential RTT p50 | ~11–14 µs | ~18–19 µs |
| Sequential RTT p99 (n=2000) | ~99–127 µs | ~90–128 µs |
| 1000-msg burst, 50 in flight | 0 loss, ~139–160k msg/s | 0 loss, ~70–71k msg/s |
| Kill core (SIGTERM) | exits, respawn + first RTT ≈ 1 ms | server close ≈ 0.2 ms |
| Browser death | pipe close → core EOF → exit 0 in <1 ms | n/a (see below) |
| Browser restart recovery | respawn core (stateless host side) | client reconnect ≈ 2 ms, **core state survives** |
| Auth | OS pipe identity (no secret) | per-launch token enforced (wrong token → 401, verified) |

## Decision

**Ship stdio via Subprocess as the primary transport (confirms D-06).**
Reasons: lower latency and ~2× burst throughput with zero dependencies;
simplest security story (no port, no token, no secret to rotate — the pipe
is the credential); browser-death cleanup is automatic (EOF → core exits,
no orphaned core holding locks); kill/restart recovery is ~1 ms.

**Keep the loopback-WS design as fallback, not implemented now:** random
`127.0.0.1` port + per-launch token passed on the command line, wrong token
→ refuse. Its one genuine advantage is core-state survival across browser
restarts (measured 2 ms reconnect); if P2 finds a workflow where core
warm state must outlive the browser process, revisit. Known WS costs:
token lifecycle, port-scanning neighbours on shared machines, extra
framing/parse code on both ends.

## Per-OS notes (from pinned source, not yet executed)

- Unix (`subprocess_unix.sys.mjs`): fork/exec via ctypes worker; absolute
  `command` required — resolve with `Subprocess.pathSearch` if needed.
- Windows (`subprocess_win.sys.mjs`): separate backend; `kill()` is forceful
  immediately (no SIGTERM grace); PATHEXT-aware `pathSearch`.
- macOS: `disclaim: true` exists for 10.14+ privacy-prompt attribution;
  ignored elsewhere. Evaluate in P9 whether the core needs it.
- Deadlock rule (docs): never `await` a large `stdin.write` before reading;
  the chrome pump (`BootSidecar.pump`) reads unconditionally, writes
  fire-and-forget — matches the doc's prescribed pattern.

## Proposal for DECISIONS.md (orchestrator to merge)

> D-31: Sidecar transport is stdio via `Subprocess.call` with Appendix C
> frames (4-byte BE length + UTF-8 JSON); `BootSidecar.sys.mjs` owns
> launch/framing/restart. Loopback WebSocket (random port + per-launch
> token) is the documented fallback if stdio fails on any OS; core-state
> survival is its only measured advantage. Evidence: P1-T09 spike,
> `tests/contract/sidecar_spike.mjs` PASS, `docs/astra/spikes/U-01-decision.md`.

## Follow-ups (not this task)

- P2: wire `BootSidecar` into startup + `jar.mn`, re-run harness against the
  built browser; add `AsyncShutdown` kill-blocker per the docs pattern.
- P9/P10: execute the Windows/macOS legs of this matrix.
- Kill-browser (browser killed, core alive) for stdio ends in core EOF exit
  by design; if warm restart is ever required, that is the trigger to
  implement the WS fallback.
