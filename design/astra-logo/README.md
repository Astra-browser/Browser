# Astra — logo exploration and rationale

Design record for the Astra product mark. The shipped artwork lives in
`branding/assets/` (masters) and `overlay/astra/branding/` + `ui/app/public/`
(generated); this folder keeps the reasoning, the alternative directions and the
usage rules.

## What this is

- `sheets/` — the concept exploration sheet, the identity board, and a browser-context board.
- `explorations/` — the six explored concepts, as built (not for production use).
- `GUIDELINES.md` — idea, construction, clear space, sizes, colour, misuse.
- Production masters: `branding/assets/`; regenerate rasters with
  `python3 tools/brand-assets.py`.

## The six concepts and the choice

| | Concept | Idea | 16 px verdict |
|---|---|---|---|
| A | Bearing | A needle without a ring | thin, reads as a paper plane |
| B | Current | One tapered current | elegant large, dies small |
| C | Waypoint | A bearing and its light | dot collapses into the lens |
| D | Aster | Custom A, crossbar running past | legible, but reads as "4" |
| E | Counterpoint | A peak holding light | bold, but generic |
| F | **Sail** | **A sail filling with wind** | **holds as a solid silhouette** |

Chosen: **F**. It is the only direction that is a symbol rather than a letter,
holds at 16 px, avoids the category's clichés (star, orbit, window, compass),
and carries a story that is not a description of the product.

## Rebuild

Edit `branding/assets/*.svg`, then run `python3 tools/brand-assets.py`. Do not
hand-edit the generated PNG/ICO/ICNS — the mark's ratios are load-bearing and
every size is derived from the same masters.

## Status

- Geometry: final (audit 100/100 on the lockup and app icon).
- Colour: monochrome ink/paper. No brand accent chosen yet.
- Type: Inter Display Medium, outlined, OFL. Bespoke typeface: not commissioned.
- Trademark: not cleared.
