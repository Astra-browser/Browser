# UI rebrand report — P3-T01 (frame → `ui/app`)

## Deliberate hand-edit of generated `bindings.ts` (3 wire literals)

`voiceChooseEngine` param, `VoiceEngineV1`, `RuntimeSecurityUpdateTarget`:
`"prev"` → `"astra"`. These are wire-protocol values shared with the Rust
side (`…-voice` crate, updater). The UI adopts the new values now; P2-T02
regenerates this file from rebranded Rust types and must produce identical
literals. Frontend rule "never hand-edit bindings" is suspended for exactly
these 3 literals, recorded here.

## Mapping applied (`prev` = previous product name, any case)

| From | To |
|---|---|
| `PrevX` / `prevX` (identifiers) | `AstraX` / `astraX` |
| `Prev` / `prev` (words, incl. `data-*` sentinels, CSS classes, `__…RuntimeV1`; `prev:` channels pending P2-T02, see below) | `Astra` / `astra` |
| `PREV_COMPONENT_BROWSER` (vitest env) | `ASTRA_COMPONENT_BROWSER` |
| `https://prev.app[/…]`, `api.prev.app` | `https://astra.example[/…]`, `https://api.astra.example` (OWNER placeholders) |
| `github.com/prev/browser`, `github.com/prev-browser/Prev` | `github.com/astra-browser/Astra` (placeholder) |
| discord / youtube community links | `example.com` placeholders (owner supplies) |
| `http://prev-media.localhost` | `http://astra-media.localhost` (functional local scheme) |
| de.json genitives | `Astras` (matches en.json "Astra's") |

Filenames renamed (§3.2): `PrevTile/` → `AstraTile/` (+ component),
`PrevMark.svelte` → `AstraMark.svelte`, `AiPrevRow.svelte` →
`AiAstraRow.svelte`, `public/prev-*` → `public/astra-*`.
`public/prev-text.svg` deleted (unreferenced).

## Placeholders (owner art pending, OWNER_QUESTIONS.md Q1)

- `public/astra-icon.png` / `@2x`: solid neutral tiles (generated).
- `public/astra-wordmark.svg` + `WORDMARK.d` in `src/shared/lib/wordmark.ts`:
  text-based "Astra" SVG + full-viewBox rect path; same viewBox/metrics so
  NewTab layout geometry is unchanged.
- Old wordmark letterform path data removed (brand + trademark hygiene).

## Verification (this task)

- `grep -ri prev ui/app` (previous product name) → only `bindings.ts` (generated, tracked for P2-T02).
- No dangling references to renamed files/components (grep over src/public/html).
- Package manager: Bun workspace (`ui/package.json`, `bun.lock` committed);
  `pnpm run` → `bun run` in app scripts (D-09; snapshot AGENTS.md used pnpm).
- Gates: `bun run typecheck`, `bun run test`, `bun run build` (results recorded
  in STATE notes at merge).
