import "$styles/global.css";
import { afterEach, expect, test } from "vitest";

// The window ground is the product's own colour, never the desktop's. A
// translucent ground let the OS backdrop through the window's gutter — Mica
// samples the wallpaper, and Windows only wakes that backdrop for the focused
// window, so the whole window changed colour the moment anything in it was
// clicked.
function alphaOf(color: string): number {
  const rgb = /rgba?\(([^)]+)\)/.exec(color);
  if (rgb) {
    const parts = rgb[1]!.split(/[,\s/]+/).filter(Boolean);
    return parts.length >= 4 ? Number(parts[3]) : 1;
  }
  // A `color-mix()` computes to `color(srgb r g b / a)`.
  const mixed = /\/\s*([\d.]+%?)\s*\)/.exec(color);
  if (mixed) {
    const value = mixed[1]!;
    return value.endsWith("%") ? Number.parseFloat(value) / 100 : Number(value);
  }
  return 1;
}

afterEach(() => {
  const root = document.documentElement;
  delete root.dataset.material;
  delete root.dataset.theme;
});

for (const material of ["mica", "acrylic"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`the window ground is opaque, ${material} ${theme}`, () => {
      const root = document.documentElement;
      root.dataset.material = material;
      root.dataset.theme = theme;

      expect(alphaOf(getComputedStyle(document.body).backgroundColor)).toBe(1);
    });
  }
}
