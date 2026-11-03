# Astra core store (P5b)

`astra-core` is the sidecar that owns Astra **organisation** — spaces, folders,
pins, order, the active tab — in the `astra-store` SQLite file. The browser
still owns live tab objects; this process persists only the organisation
snapshot described by `crates/astra-core/src/session.rs`
(`SessionSnapshot`, version 1).

## Binary

```
crates/astra-core/src/bin/astra_core.rs   -> target/{debug,release}/astra-core
astra-core --db /path/to/core.sqlite
```

`--db` is required (or `ASTRA_CORE_DB`). The parent directory is created, WAL
and foreign keys are on, and migrations run at startup. The process writes one
line to stderr naming the file it opened.

## Protocol

Appendix C frames over stdin/stdout (`astra-proto`): 4-byte big-endian length
plus one UTF-8 JSON envelope. `v` must be `PROTOCOL_VERSION`; a mismatch gets a
`version_mismatch` reply and the process exits 1.

| Command | Payload | Reply |
|---|---|---|
| `boot.handshake` | `{core_version}` | `{core_version, protocol, schema}` |
| `session.save` | `{name?, snapshot}` | `{saved: true, updated_at}` |
| `session.load` | `{name?}` | `{snapshot, updated_at}` or nulls |
| `core.shutdown` | `{}` | `{shutdown: true}`, then exit 0 |

`name` defaults to `organisation`. `session.save` validates with
`SessionSnapshot::from_json` and stores the **canonical** serialization; an
invalid or future-version snapshot is refused with `invalid_snapshot` and the
previous row is untouched. Unknown commands answer `unknown_command`. stdin EOF
exits 0, so a browser crash cannot leave a zombie holding the file.

## Durability

Each save is one SQLite transaction (WAL). `crates/astra-core/tests/core_binary.rs`
spawns the real executable and proves: save in one process, load in a new one,
invalid payloads refused without clobbering the last good row, named snapshots
independent, version gate, EOF exit.

## Status

P5b-1 (this binary) is merged. **P5b-2** — the host capture/apply wiring and the
quit/relaunch proof — is still open: the shell does not launch this binary yet,
so no user-visible metadata survives a restart through it.
