# Element hiding (P4-T03)

Cosmetic filtering plus click-to-hide, served through the `Content` actor
family. Implementation: `overlay/astra/host/ContentHide.sys.mjs`
(protocol: `schemas/content-hide.json`). Every call echoes `request_id`
and carries `host_api_version: 1`; failures return
`{ error: { code, message } }` with `invalid_url` / `invalid_host` /
`invalid_selector` / `not_picking`.

## Cosmetic filters

`hideForPage(doc, { url })` runs one hiding pass:

1. `collectObserved(doc)` gathers the page's classes/ids across the main
   document, same-origin iframes, and open shadow roots.
2. The injected cosmetic provider resolves them — production passes
   `Blocker.cosmeticPayload(url, classes, ids)`, which reads the in-tree
   engine's `cosmeticFor` (`blocker/engine`, Brave `adblock-rust`). It merges
   URL-specific selectors with the generic rules matching the observed
   classes/ids (hostname exceptions and `$generichide` honoured inside the
   engine). The same payload feeds the `AstraBlocker` page actor, which
   injects the CSS and scriptlets in the content process.
3. Stored per-site overrides for the page host are merged in, and
   `applySelectors` hides every match (`display: none` + marking via
   `data-astra-hide="1"`, so repeat sweeps are idempotent).

The caller re-runs the pass as more classes appear (e.g. on DOM
mutations). `buildStylesheet(selectors)` renders the shared
`display:none!important` text the live content script injects.

## Click-to-hide

`startPicking()` arms the picker (emits
`content-hide.picking-started`); the chrome UI highlights the hovered
element. `confirmPick({ url|host, selector|element })` derives a stable
selector (`#id`, else first class, else tag path via
`selectorForElement`), stores it per-site, disarms the picker, and emits
`content-hide.rule-added`. `cancelPicking()` disarms without storing.

## Per-site persistence (no reschema)

Rules persist through the injectable store adapter
(`setStoreAdapter({ load, save })`; in-memory by default). The production
adapter maps onto the existing `blocker_overrides` table from P2-T04
(`crates/astra-store`, unique index on `host`): each confirmed selector is
one row written via the existing `blocker_override_set(host, action)`
with `action = "cosmetic-hide:<selector>"`. No table or index changes —
this module only defines the action-value convention. `listRules` /
`removeRule` / `clearSite` round-trip through the same adapter.

## Scope traversal

`scopesOf(doc)` yields the document, every same-origin iframe
`contentDocument` (recursively), and every open shadow root, so one pass
covers static pages, iframes, and shadow-DOM widgets. Cross-origin
iframes are unreachable by design — their rules still apply on direct
visit. Rule management (`addRule`, `removeRule`, `listRules`,
`clearSite`) is host-keyed with `normalizeHost` (lower-case, trimmed),
mirroring the blocker engine.

## Live wiring (orchestrator)

The live shell injects the content script, forwards `MutationObserver`
sightings into repeated `hideForPage` passes, wires the real cosmetic
provider and the `blocker_overrides` store adapter, and registers the
module on the `Content` actor at merge. Contract coverage:
`tests/contract/content_hide.mjs` (fake-DOM fixtures: static, iframe,
shadow, picking flow, persist round-trip) and
`tests/contract/content_hide.py` (schema/protocol shape).

## Status: P4-T11 live wiring landed

- Content script driver: `installLiveHiding(doc, { url })` in
  `overlay/astra/host/ContentHide.sys.mjs` runs the initial `hideForPage`
  pass, injects one `<style id="astra-hide-style">` via
  `injectStylesheet` (`buildStylesheet` text), and re-passes on DOM
  mutations through `MutationObserver` (microtask-debounced; no-op detach
  where no observer exists). `Content.attachHiding(doc, opts)` exposes it
  on the actor.
- Cosmetic provider: `createBlockerCosmeticProvider(nativeCosmetic)`
  adapts the blocker's `cosmetic_selectors(url, classes, ids)`
  (`crates/astra-blocker`) to the async seam; native failures degrade to
  "no filter selectors". There is no pre-existing Rust→JS bridge in the
  overlay (the P4-T02 engine is reached from C++, not chrome JS), so the
  live shell injects its privileged lookup via
  `Content.wireHiding({ cosmeticSelectors })`; until that lands the empty
  default stands and only stored overrides apply.
- Store adapter: `createOverrideStoreAdapter({ setAction, getActions })`
  persists through the write-only `blocker_override_set(host, action)`
  (`crates/astra-store` has no override getter) with
  `action = "cosmetic-hide:<selector>"`, keeping an in-memory mirror for
  `load` that an optional native reader feeds when available.
- Registration: `Content.ContentHide` on the actor +
  `Content.wireHiding`/`attachHiding`, `ContentHide` re-exported from the
  `HostAPI.sys.mjs` facade (reset covered), `jar.mn` registers
  `ContentHide.sys.mjs`. Protocol unchanged, so `schemas/content-hide.json`
  is untouched.
- Bridge: `ui/packages/bridge/src/content-hide.ts` maps the eight methods
  to `hide_*`/`hide_pick_*`/`hide_rule_*` commands and declares the four
  `content-hide.*` events, with `registerContentHideMock` for standalone
  UI tests (covered by `content-hide.test.ts`).
- Live browser check is skip-gated: no in-tree geckodriver is present in
  this environment, so no Marionette run was possible; Node/python
  contract suites stay green (see phase report).
