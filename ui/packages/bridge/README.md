# `@astra/bridge` (P2-T08)

Tauri-shaped `invoke` / `listen` / `once` / `getCurrentWindow` over the Astra
Host API + Appendix C stdio frames, with a standalone MOCK mode.

- **Firefox chrome** — Appendix C envelopes (`makeRequest` / `parseEnvelope`,
  copied with provenance note into `src/proto.ts` from
  `crates/astra-proto/gen/astra-proto.ts`) are dispatched to the Host API
  (`overlay/astra/host/*.sys.mjs`) via `createHostDispatch`. The route table is
  built from `src/manifest.ts` (D-55); a command it does not mark `routed`
  fails fast with `unknown_command`.
- **Standalone** (goldens / dev) — `MockHost` answers every command in the
  manifest (317 wire names) in-memory with a monotonic `event_seq`, so the UI
  runs under plain `http(s)`/`file` with zero Firefox.
- **Resync** — `EventBus` tracks `event_seq` per Appendix C §5.4; a gap fires
  `onGap` while still delivering the newest payload, so the UI resyncs
  instead of rendering stale state.

## Use

```ts
import { configureBridge, invoke, listen } from "@astra/bridge";

// Standalone / tests:
configureBridge({ mode: "mock" });
const info = await invoke("ui_info");
const unlisten = await listen("tab-changed", (e) => console.log(e.payload));
```

App wiring (surface selection, `resource://` Host loading) lives in
`ui/app/src/shared/ipc/bridge.ts` (`ensureBridge(label)` per entry surface);
UI call sites keep their `@tauri-apps/api` shapes and swap the import
source as migration proceeds.

## Tests

- `bun test ./src` — 31 tests: manifest <-> route table equality, full-surface
  mock coverage (317 manifest names; the frozen registry holds 281 commands and
  38 events), invoke fixtures + errors, listen/once/unlisten, `event_seq` gap +
  version gate, MockHost seq/reset, host route table.
- `ui/app/src/shared/ipc/bridge.test.ts` — 7 wiring tests under the frame
  runner (`bun run test`).
