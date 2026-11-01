# Golden masks — per-region diff policy (§9.2)

Comparisons are standalone-baseline vs in-Firefox captures (P3-T11). Pixel
diffs use the threshold **≤ 1.5% differing pixels per screen** (ratchet down
as parity improves). These regions are masked or treated specially because
they are nondeterministic or engine-rendered, never because the chrome differs.

## Fully masked (excluded from diffs)

| Region                                                                                        | Why                                                                                                                                                  |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web content pane (`[data-astra-content]`, `.content-pane[data-ground="own"]` in browse state) | Live page pixels belong to the engine, not the chrome. Goldens assert chrome around the pane, never inside it.                                       |
| New-tab sky imagery (`.newtab` background layers, baked `sky-*.avif`)                         | Decoded-image + GPU-gradient variance across machines; the sky composition itself is covered by `NewTab*Look` component tests with fixed rasters.    |
| Favicon rasters in tabs/spaces                                                                | 32px canvas rasters; identical bytes in practice, but regenerated per run — mask only if a run shows canvas-quantization drift.                      |
| Launcher result rows (`ResultList`)                                                           | Result text is deterministic fixtures, but row order/timing depends on debounced search; compare structure (field visible, list present) not pixels. |

## Compared with tolerance

| Region                                  | Treatment                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All text (sidebar, tabs, pages)         | Antialiasing tolerance: allow 1-px edge drift; font stack must match MANIFEST pinned fonts or the run is invalid.                                      |
| Theme backgrounds, borders, glass tints | Exact match required at `ui.material = none` (the baseline matrix pins material to `none`; liquid-glass captures are a separate matrix, not this one). |
| Focus rings, selection, hover           | No hover in captures (no cursor); focus is fixed per screen (new-tab search focused; launcher combobox focused).                                       |

## Never masked

Sidebar column, tab strip, spaces switcher/editor, settings cards, tasks
lists, notes list/editor, time charts (SVG — deterministic fixtures),
launcher field/sheet geometry, window caption/drag regions.
