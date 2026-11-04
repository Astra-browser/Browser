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

## Host wiring (P5b-2)

`Metadata.sys.mjs` owns the browser side:

- `forge build` builds `astra-core` (release by default) and installs it in
  `dist/bin`. The shell uses `astra.core.command` when set, otherwise it looks
  for `astra-core` next to the browser binary; with neither it answers an
  honest `unavailable`. The database is `<profile>/astra/core.sqlite` (or the
  `astra.core.database` override).
- Before `Tabs.bootstrap`, `prepare()` loads the snapshot and installs the saved
  spaces, so a tab adopted from SessionStore lands in a space that exists.
- After `Content.mountNative`, `restore()` matches saved tabs to live tabs by
  URL (one snapshot entry per live tab, in position order) and re-applies the
  space and pin.
- `init()` saves on organisation events (`space.*`, `tab.*`, `items-changed`,
  `nav.committed`) with a 600 ms debounce. Quit rewrites the **last accepted**
  snapshot rather than capturing a tearing-down window.

Privacy rules, all fail-closed:

| Rule | Effect |
|---|---|
| Only `tab.private === false` | `Content` stamps privacy from the window when it binds the native tab; an unmarked tab is not captured |
| Private windows are dropped | a private window neither restores nor saves (`prepare`/`save`/`restore` return `private`) |
| Only `http:`/`https:` URLs | New Tab, `about:`, `data:`, `file:`, `blob:` never reach disk |
| Empty capture never overwrites | a window with no persistable tab leaves the saved organisation alone |
| Window list unavailable | the save is refused, not guessed |

Live proof: `tools/perf/stress/metadata_restore_probe.py` creates a Work space
with a pinned tab, saves, opens a private window (which must refuse to save),
checks the SQLite row has no private URL, quits cleanly, relaunches, and
re-applies the saved organisation to a tab at the saved URL.

## Known limits

- **Multi-window:** each window's `Metadata` writes its own model, so the last
  writer wins. A single-window profile is correct; a multi-window merge is
  P5b-3.
- **Folders:** the UI's tab folders still live in `localStorage`; the store
  schema and `SessionSnapshot.folders` are ready, but the host has no folder
  model to capture yet.
- **Scroll/zoom/history:** `SessionStore` owns those; the snapshot carries only
  organisation.
