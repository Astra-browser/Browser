# Security policy — Astra (P0-T10)

## Scope

This policy covers the Astra browser (Gecko host + `astra-core` sidecar),
`astra-cloud` sync/update servers, and this repository.

## Security model (summary, full: plan §5.5)

- Untrusted web pages never share a process or privilege with Astra UI.
- Sidecar IPC is private to the parent process (pipes) or token-authenticated
  loopback only. No unauthenticated TCP, ever.
- Agent side effects (post, merge, send, delete, run command) require explicit
  user approval enforced in `astra-core`, not in UI.
- Secrets live in the OS keychain only — never in SQLite, logs, or sync
  payloads. No telemetry (plan D-15).

## Reporting a vulnerability

Email the owner (see `branding/astra.toml` `support_url` once set; until then
file a private issue). Include: affected version/channel, repro steps or PoC,
and impact assessment. Do not open public issues for unpatched
vulnerabilities.

## Response targets

- Triage within 48 h. Upstream security releases ship to users within 72 h
  (plan §6.6 SLA). Out-of-band fixes follow plan §11.4 (fast-path pipeline,
  staged rollout, post-incident note).
- Supported: latest `release` channel and the current `release/<major.minor>`
  branch. `nightly`/`beta` are best-effort.

## Hard requirements for releases

Endpoint audit clean, telemetry guard green, `cargo audit/deny/vet` clean for
in-tree crates, secrets scan clean, fuzz + prompt-injection suites passing
(plan §9.3). A release missing any of these does not ship.
