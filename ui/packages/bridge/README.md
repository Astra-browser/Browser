# `@astra/bridge` (P2-T08)

Tauri-shaped `invoke` / `listen` / `once` / `getCurrentWindow` over the Astra
Host API + Appendix C stdio frames, with a standalone MOCK mode.

- **Firefox chrome** — Appendix C envelopes (`makeRequest` / `parseEnvelope`,
  copied with provenance note into `src/proto.ts` from
  `crates/astra-proto/gen/astra-proto.ts`) are dispatched to the Host API
  (`overlay/astra/host/*.sys.mjs`) via `createHostDispatch`. Only the domains
  P1-T10 specified (Tabs / Navigation / Panes / Boot handshake) are routed;
  the rest fail fast with `unknown_command` until P2-T06 lands live bindings.
- **Standalone** (goldens / dev) — `MockHost` answers all 267 commands
  in-memory with a monotonic `event_seq`, so the UI runs under plain
  `http(s)`/`file` with zero Firefox.
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

- `bun test ./src` — 19 tests: full-surface coverage (267 cmds / 35 evts),
  invoke fixtures + errors, listen/once/unlisten, `event_seq` gap + version
  gate, MockHost seq/reset, host route table.
- `ui/app/src/shared/ipc/bridge.test.ts` — 7 wiring tests under the frame
  runner (`bun run test`).
