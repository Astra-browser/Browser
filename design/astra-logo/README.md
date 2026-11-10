# Astra — logo exploration (staged, not wired)

Design exploration for the Astra product mark. **Nothing here is referenced by
the build yet** — `branding/astra.toml` still points at the placeholder artwork,
and wiring these files in is an owner decision (see `docs/astra/OWNER_QUESTIONS.md`).

## What this is

- `svg/` — the finished masters (SVG, paths only, no text, no filters).
- `web/` — favicon `.ico`, PNG icon set, `site.webmanifest`, `<head>` snippet.
- `png/` — PNG exports for slides and quick review.
- `sheets/` — the concept exploration sheet, the identity board, and a browser-context board.
- `explorations/` — the six explored concepts, as built (not for production use).
- `GUIDELINES.md` — idea, construction, clear space, sizes, colour, misuse.

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

The generated files come from scripts that live outside this folder, in the
design workspace used for the exploration (`bin/kit.py`, `bin/build.py`). If you
need to change geometry, do it there rather than editing paths by hand — the
mark's ratios are load-bearing.

## Status

- Geometry: final (audit 100/100 on the lockup and app icon).
- Colour: monochrome ink/paper. No brand accent chosen yet.
- Type: Inter Display Medium, outlined, OFL. Bespoke typeface: not commissioned.
- Trademark: not cleared.
