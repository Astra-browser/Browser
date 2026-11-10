# Astra brand masters

The SVGs here are the single source of truth for the Astra mark. Every PNG,
`.ico` and `.icns` in the tree is generated from them — do not hand-edit the
raster outputs.

```
python3 tools/brand-assets.py     # regenerate every size and container
```

| Master | Use |
|---|---|
| `astra-symbol.svg` | the mark alone, ink, square canvas |
| `astra-symbol-small.svg` | small-size cut (fuller head, shorter luff) |
| `astra-symbol-white.svg` / `-black.svg` | one-colour cuts |
| `astra-wordmark.svg` | outlined wordmark (Inter Display Medium, OFL) |
| `astra-lockup-horizontal.svg` | primary lockup |
| `astra-lockup-horizontal-reversed.svg` | primary lockup for ink grounds |
| `astra-lockup-stacked.svg` | secondary lockup |
| `astra-app-icon.svg` / `-dark.svg` | full-bleed icon tile (1024) |

Generated into:

- `overlay/astra/branding/` — GTK `default<size>.png`, `astra-icon-512.png`,
  `astra-logo.svg`, `astra.ico`, `astra.icns`, `content/about*`
- `ui/app/public/` — `astra-icon.svg` (SVG-first), `astra-icon.png`/`@2x`,
  `astra-wordmark.svg`, `astra-symbol.svg`, `favicon.svg`/`.ico`, web icons

Rationale, clear space, minimum sizes and misuse: `docs`-adjacent brand notes in
`design/astra-logo/GUIDELINES.md`. The mark is a sail, navigated by stars — a
sail filling with wind, with the star implied by the act of navigation rather
than drawn.
