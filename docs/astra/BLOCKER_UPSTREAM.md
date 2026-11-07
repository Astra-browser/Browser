# Blocker upstream map — Brave repositories → Astra

The four repositories the owner supplied are **reference material**. They are
cloned under `folder_context/` (git-ignored) and never linked at runtime.
`blocker/tools/sync.py` reads them and writes the two committed data files;
`blocker/engine/` is Astra's own native component built on the vendored
`adblock-rust` crate.

| Upstream | Revision used | Taken | Dropped | Why |
|---|---|---|---|---|
| `brave/adblock-rust` | `0.13.5` clone; engine pinned to the audited `0.12.1` vendored by Gecko | API shape, semantics, resources/cosmetic model | JS bindings, npm package, benches | The pinned engine is already vendored and audited in ESR 153; adding 0.13.5 would compile a second engine and require a `mach vendor rust`/audit round for no matching gain. Verdict semantics are pinned by the shared fixtures. |
| `brave/adblock-resources` | commit in `catalog.json → upstream` | `dist/resources.json` entries: `de-amp.js`, `touch-fix.js`, `trusted_types.js`, `vaft-ublock-origin.js`, `video-swap-new-ublock-origin.js` | `brave-*.js`, `async-sugarcoat-*`, Brave metadata | Brave product scriptlets and SugarCoat bundles are not generic adblock data. |
| `brave/adblock-lists` | commit in `catalog.json → upstream` | Catalog structure and the community sources it references | Every `brave-*` and `brave-unbreak` source; Brave service allow-rules; Brave update hosts | Brave-owned lists contain `@@||brave.com^`, statcounter allowances and update endpoints that must not answer in Astra. |
| `brave/adblock-lists-mirror` | commit in `catalog.json → upstream` | Nothing at runtime; recorded for provenance | Generated mirrors | The mirror is a packaging artifact for other consumers, not a source Astra needs. |

## Catalog selection

`sync.py` walks `adblock-resources/filter_lists/list_catalog.json`, keeps
every source whose URL does **not** belong to a Brave-owned host, classifies it
into `ads` / `privacy` / `malware` / `annoyances` / `regional`, and marks the
default set:

- **Ads (default):** uBlock Origin filters, general, quick-fixes, unbreak,
  resource-abuse, badware; EasyList.
- **Privacy (default):** EasyPrivacy, uBO privacy.
- **Malware (default):** URLhaus malicious URL blocklist.
- **Optional:** cookie/annoyance lists, YouTube-specific lists, regional lists.
  They are off by default and selectable in Settings.

Every entry keeps `source_url`, `support_url`, `license` and `bundled`.

## Rebrand / telemetry check

`sync.py --check` (and the import itself) fails when a shipped title, source
URL or resource name matches `brave|rewards|telemetry|p3a|analytics`. The only
place the Brave name appears in the product is factual licence attribution in
`blocker/NOTICE.md`, `docs/astra/PROVENANCE.md` and the `upstream` provenance
block in `catalog.json`.
