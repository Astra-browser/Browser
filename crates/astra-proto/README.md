/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

# `astra-proto` — versioned JSON protocol (P2-T02)

Single source of truth: `docs/astra/ipc-surface.md` (276 commands + 36 events).
`crates/astra-proto/codegen/generate.py` parses it and emits everything else:

| Output | Source |
|---|---|
| `schemas/commands.json`, `schemas/events.json` | generated from `ipc-surface.md` |
| `schemas/envelope.json` | **hand-written** (stable Appendix C contract) |
| `crates/astra-proto/src/generated.rs` | generated `CommandName`/`EventChannel` registries |
| `crates/astra-proto/gen/astra-proto.ts` | generated TS types + `makeRequest`/`parseEnvelope` |
| `crates/astra-proto/fixtures/commands/*.json` | generated minimal valid payloads (one case per command) |
| `crates/astra-proto/fixtures/envelope-*.json`, `negative/` | hand-written envelope cases |

Wire format (plan Appendix C): 4-byte big-endian length + UTF-8 JSON
`{v, id, kind: req|res|evt, name, seq?, payload, error?}`.
Unknown fields are **ignored** on receipt (serde default, no
`deny_unknown_fields` — verified against serde docs via Context7);
unknown protocol versions **fail fast** (`check_version` / `parseEnvelope`).

## Gates

```sh
crates/astra-proto/check-drift.sh       # full gate: drift + fixtures + cargo + bun + tsc
FIX=1 crates/astra-proto/check-drift.sh  # regenerate checked-in files after ipc-surface.md changes
```

CI must run `check-drift.sh` and fail on exit 1.

## Event renames

The 10 channels carrying the previous product's `prev:` prefix are renamed to
`astra:` (e.g. `prev:swipe` → `astra:swipe`, TS `prevSwipe` → `astraSwipe`).
Full map in `schemas/events.json` → `renames` (also exported as
`EVENT_RENAMES`). Note: plan prose says "8 REN channels" but the
`ipc-surface.md` table actually contains **10** `prev:` rows — the table
(and this crate) is authoritative.

## Dependency justification (keep-it-minimal)

- Rust runtime: `serde` 1 (derive) + `serde_json` 1 only. Resolved versions are
  pinned in `Cargo.lock` (`serde 1.0.229` at time of writing). No `schemars`:
  codegen direction here is schema→code, not code→schema, and the sidecar
  must stay lean. Unknown-field tolerance comes from serde's default
  (non-denying) derive, not an extra crate.
- Generator/validator: stdlib-only Python 3. No `jsonschema`/`ajv` — the
  schemas use a flat subset the 80-line validator covers; pulling a validator
  dependency for that would cost more than it proves.
- TS emitter: hand-rolled in `generate.py`, no `json-schema-to-typescript`
  npm chain (that generator's output for 267 mostly-opaque payloads would add
  a heavy dev-dep for zero fidelity gain). `bun test` (repo standard, D-09)
  is the TS gate; `tsc --noEmit` (pinned `typescript@7.0.2` via npx) additionally
  type-checks the generated module.

## Known v1 fidelity limits

- Complex Tauri Specta payload/return types (e.g. `prev_ipc::BlockerStatsView`)
  are not available as JSON schema in `ipc-surface.md`; they map to
  unconstrained schemas annotated `x-astra-rust-type`, and to `unknown` in TS.
  Scalar params (`String`/`bool`/`f64`/`u32`/…) and `Vec<T>`/`Option<T>` are
  fully typed, including `required`. Full Specta-type ingestion is a P2
  follow-up once `bindings.ts` is replaced (the generated `bindings.ts` is
  explicitly excluded from brand-lint until then).
- `expected_profile` is kept as a payload field (container scoping, D-12);
  `caller`/`app`/`shell`/other `State` handles are transport-level and stripped.
- P1-T10 `overlay/astra/host/schemas/*.json` (Host API stub modules) are a
  different layer (P2-T06 owns them) and are untouched; this crate's envelope
  is compatible with their `{event_seq, type, data}` events carried as `evt`
  payloads.
