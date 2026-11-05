# Downloads manager + PDF viewing (P4-T08)

Parity owner: downloads UI. Native transfers, paths, and durable history stay
in the engine behind `download_call` / `download_open_access_settings`
(`docs/astra/ipc-surface.md`); the Svelte side is a projection over
`downloads-changed` (`DownloadSession` in `ui/app/src/domain/downloads/`,
rendered by `ui/app/src/features/downloads/`).

## Native wiring (2026-11-05)

`overlay/astra/host/Downloads.sys.mjs` is backed by
`Downloads.getList(Downloads.PUBLIC)` and the engine's download preferences
(`browser.download.useDownloadDir`, `browser.download.folderList`,
`browser.download.dir`, `Downloads.getPreferredDownloadsDirectory()`). A folder
choice is `nsIFilePicker` + `folderList = 2`; the settings ask switch writes
`useDownloadDir`; native list changes emit `downloads-changed`. `list` and
`preferences` answer `supported: true` only when the engine answered, and the
settings panel renders an honest unsupported state otherwise.

Still deferred: this engine exposes no pause/resume or type-held lifecycle, so
those calls answer `unavailable`; downloads remain global rather than
per-profile until the core store owns them. The live Marionette probe (fixture
attachment, folder/ask round-trip) runs in the integration branch after the
bundle rebuild.

## What P4-T08 adds

| Piece | File | Notes |
|---|---|---|
| PDF helpers (detect, viewer URL, view-vs-open) | `ui/app/src/features/downloads/lib/pdf.ts` | Pure; unit-tested |
| Download-permission prompts over the bridge | `ui/app/src/features/downloads/lib/download-dialogs.ts` | `download.started` → `decideDownload`; MockHost-drivable |
| Built-in viewer embed | `ui/app/src/features/downloads/components/PdfViewer.svelte` | Iframe over the engine viewer + standalone fallback |
| Unit tests | `tests/pdf.test.ts`, `tests/download-dialogs.test.ts` | `bun run test` |
| Component tests | `tests/downloads-manager.component.test.ts`, `tests/pdf-viewer.component.test.ts` | `test:component` (list/progress/cancel/reveal; PDF opens in viewer) |

Pre-existing (ported earlier, not touched): `DownloadsList`, `DownloadStatus`,
`DownloadPulse`, `FileGlyph`, `transfer.ts`, `errors.ts`, and the
`DownloadSession` projection with its tests.

## PDF decision: built-in viewer, integrated — not custom

**Recommendation: embed Firefox's built-in pdf.js viewer; do not build or
bundle a custom renderer.**

- **It is the engine's own viewer.** Firefox ships a full pdf.js build
  (render, text layer, search, print, forms, a11y tree) updated with every
  ESR. A custom viewer would re-ship a second PDF engine next to the first.
- **Security posture.** The viewer runs on a privileged `resource://`
  document with the engine's sandboxing and content policy; a custom viewer
  in chrome-privileged Svelte would widen the content-to-chrome surface for
  every malformed file the web can serve.
- **Parity for free.** Annotations, find, presentation mode, and screen-reader
  support track ESR upgrades with zero Astra code.
- **Cost.** Integration is one iframe URL
  (`resource://pdf.js/web/viewer.html?file=<encoded>`, default in
  `lib/pdf.ts`); theming is limited to what the viewer document exposes —
  accepted, since matching viewer chrome pixel-for-pixel is not a parity row.

Against: the exact `resource://pdf.js/` path and `?file=` contract must be
pinned against ESR 153 at assembly time (web search was unavailable from
this lane; the base is an overridable `viewerBase` prop default, not a
constant baked into markup). If ESR moves the viewer document, only the
default changes.

## Bridge gap (assembly follow-up — do not fix in this lane)

P3-T09 specifies `Dialogs.requestDownload` / `decideDownload` and the
`download.started` / `download.resolved` events
(`overlay/astra/host/Dialogs.sys.mjs`, `docs/astra/DIALOGS.md`). The UI side
here consumes them **read-only** through `@astra/bridge`:

- `DownloadPromptSession` (`lib/download-dialogs.ts`) listens for
  `download.started` and answers via `invoke("decideDownload", …)`,
  mirroring the host's `no_such_dialog` / `already_resolved` gates.
- **Missing on the bridge today:** no `download.started` event in the proto
  `EVENTS`, no `decideDownload` command in `COMMANDS`, no `Dialogs` module
  in `HostModules`, and no Dialogs routes in `host-transport.ts` (Tabs /
  Navigation / Panes / Boot only). Bridge files are outside this lane, so
  they are untouched.
- **Stub:** `DownloadPromptSession` is framework-free and the unit suite
  drives it through `MockHost` — `emitEvent("download.started", …)` flows
  through the event pump and unrouted `decideDownload` answers
  `{ ok: true }`. Real end-to-end (engine prompt → UI → file write) resolves
  once the assembly wires `Dialogs.requestDownload` / `decideDownload` into
  `host-transport.ts` + proto, then swaps the mock for the host bridge.

## Wiring follow-ups (not this lane)

1. Assembly: pin `PDF_VIEWER_BASE` against ESR 153 and add the Dialogs
   download routes above.
2. UI owner of the library surface: offer "view in viewer" for finished PDF
   entries (via `pdfOpenAction` + `PdfViewer`) next to the existing
   open/reveal actions — `DownloadsList.svelte` was deliberately not edited
   here.
3. i18n owner: the two fallback strings in `PdfViewer.svelte` are hardcoded
   English; new `messages/en.json` keys are outside this lane.
