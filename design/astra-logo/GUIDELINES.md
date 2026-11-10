# Astra — logo guidelines (draft v1)

## The idea

**A sail, navigated by stars.**

Astra's mark is not a star, a planet, an orbit or a browser window. It is a sail:
the oldest interface between a person and something vast. You set it, and the
open space starts to move with you.

The star is never drawn. It is implied by the act of navigation — which is what
Astra actually sells: a calmer way to cross the web.

One shape. No gradient, no ring, no container doing the work.

## Construction

- Canvas 256 × 256 units; the mark is built from two straight edges and one curve.
- **Luff** (leading edge): exactly vertical, 200 units — a mast.
- **Foot**: rises 15° from the tack to the clew — a boom lifting.
- **Leech** (trailing edge): a single cubic, convex, fuller low and hollow near the head.
- **Head**: a short gaff, not a point — this is what separates the mark from a flame.
- The three corners are sharp on purpose. A sail is tension, not softness.

Do not redraw these relationships by hand. Change `bin/kit.py` and rebuild.

## Clear space

Minimum clear space on all sides = **half the x-height of the wordmark** (or, for
the symbol alone, half its width). Nothing intrudes: no text, no rule, no edge.

## Minimum sizes

| Asset | Minimum |
|---|---|
| Symbol | 16 px (use `astra-symbol-small.svg` below 32 px) |
| Favicon | 16 px, inside the paper tile |
| Horizontal lockup | 120 px wide |
| Stacked lockup | 64 px wide |

## Colour

The identity is deliberately monochrome. It is the most "less decoration" answer
available, and it is the only browser identity on the shelf with no colour crutch.

| Name | HEX | RGB | Use |
|---|---|---|---|
| Astra Ink | `#0B0B0C` | 11 11 12 | mark on light grounds, type |
| Astra Paper | `#F6F2EA` | 246 242 234 | app icon ground, reversed mark |
| White | `#FFFFFF` | 255 255 255 | mark on ink, print |

One colour only. The mark must never depend on a second colour to read.

## Backgrounds

Approved: paper, white, ink. On photography, place the mark on a solid field of
paper or ink first. Never place the mark on a busy image at small sizes.

## Misuse

- Do not add a gradient, glow, shadow, bevel or outline.
- Do not put the symbol inside a rounded-square container to make it interesting.
- Do not rotate the sail, mirror it, or stretch it.
- Do not add a star, a dot, an orbit, a horizon line or a hull.
- Do not set the wordmark in another typeface or re-space it.
- Do not rebuild the wordmark from a different weight of Inter.

## Typography

**Astra wordmark** — Inter Display Medium, outlined to paths, tracking −1.2%.
Inter is licensed under the SIL Open Font License 1.1, which permits logo use and
outlining. The wordmark is deliberately quiet: the symbol carries the identity.

If a fully bespoke typeface is commissioned later, keep the x-height / weight
relationship and the tight tracking; the lockup geometry is built around them.

## Files

| Path | What it is |
|---|---|
| `branding/assets/astra-symbol.svg` | Master symbol, ink, square canvas |
| `branding/assets/astra-symbol-small.svg` | Small-size cut (fuller head, shorter luff) |
| `branding/assets/astra-symbol-white.svg` / `-black.svg` | One-colour cuts |
| `branding/assets/astra-wordmark.svg` | Wordmark, outlined |
| `branding/assets/astra-lockup-horizontal.svg` | Primary lockup |
| `branding/assets/astra-lockup-horizontal-reversed.svg` | Primary lockup, paper on ink |
| `branding/assets/astra-lockup-stacked.svg` | Secondary lockup |
| `branding/assets/astra-app-icon.svg` / `-dark.svg` | 1024 tile, full bleed |
| `overlay/astra/branding/` | GTK icons, 512 icon, `.ico`, `.icns`, about:logo artwork |
| `ui/app/public/` | SVG-first app art, favicon set, web icons |
| `design/astra-logo/sheets/` | Concept exploration, identity board, context board |

Regenerate every raster with `python3 tools/brand-assets.py`; never hand-edit
the generated PNG, `.ico` or `.icns`.

## Known limits

- At 16 px the sail reads as a bold shard, not literally as a sail. That is
  acceptable — it is a silhouette, and it is unique on the shelf — but the
  favicon always uses the paper tile so the shape keeps its edges.
- The wordmark is set in a licensed typeface, not drawn from scratch.
- No trademark clearance has been done. Commission a professional search before
  launch (EUIPO/USPTO, plus a reverse-image search).
