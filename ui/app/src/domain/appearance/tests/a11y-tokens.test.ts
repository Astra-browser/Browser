import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

/**
 * P3-T12 accessibility pass: the theme-token contrast floor, checked
 * programmatically against the stylesheets themselves so a token edit that
 * drops a pair below its floor fails here instead of in a manual audit.
 *
 * Method mirrors WCAG 2.1 §1.4.3/1.4.11: relative luminance of the composited
 * foreground over its ground, (L1 + 0.05) / (L2 + 0.05).
 */

type RGB = [number, number, number];

const root = new URL("../../../styles/", import.meta.url);
const tokensCss = readFileSync(new URL("tokens.css", root), "utf8");
const primitiveCss = readFileSync(new URL("tokens/primitive.css", root), "utf8");
const contrastCss = readFileSync(new URL("axes/contrast.css", root), "utf8");
const motionCss = readFileSync(new URL("axes/motion.css", root), "utf8");
const globalCss = readFileSync(new URL("global.css", root), "utf8");

function block(css: string, start: string): string {
  const at = css.indexOf(start);
  if (at === -1) throw new Error(`missing block ${start}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block ${start}`);
}

function declarations(scope: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const match of scope.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g))
    vars.set(`--${match[1]!}`, match[2]!.trim());
  return vars;
}

const primitive = declarations(block(primitiveCss, ":root"));
const lightScope = block(tokensCss, '[data-theme="light"]');
const darkScope = tokensCss.slice(0, tokensCss.indexOf('[data-theme="light"]'));
const dark = declarations(darkScope);
const light = declarations(lightScope);

function parseColor(raw: string, scope: Map<string, string>): { rgb: RGB; alpha: number } {
  const value = raw.trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  if (ref) {
    const resolved = scope.get(ref[1]!) ?? primitive.get(ref[1]!);
    if (!resolved) throw new Error(`unresolvable token ${value}`);
    return parseColor(resolved, scope);
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const raw = hex[1]!;
    const digits =
      raw.length === 3
        ? raw
            .split("")
            .map((c) => c + c)
            .join("")
        : raw;
    const n = Number.parseInt(digits, 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb = /^rgb\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)(%?)\s*\)$/.exec(value);
  if (rgb) {
    const alpha = Number(rgb[4]) * (rgb[5] === "%" ? 0.01 : 1);
    return { rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])], alpha };
  }
  throw new Error(`unsupported token value ${value}`);
}

function composite(fg: RGB, alpha: number, bg: RGB): RGB {
  return [
    Math.round(alpha * fg[0] + (1 - alpha) * bg[0]),
    Math.round(alpha * fg[1] + (1 - alpha) * bg[1]),
    Math.round(alpha * fg[2] + (1 - alpha) * bg[2]),
  ];
}

function luminance([r, g, b]: RGB): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function ratioOf(fgRaw: string, bgRaw: string, scope: Map<string, string>): number {
  const fg = parseColor(fgRaw, scope);
  const bg = parseColor(bgRaw, scope);
  if (bg.alpha !== 1) throw new Error(`background must be opaque: ${bgRaw}`);
  const lum = (c: RGB) => luminance(c);
  const hi = lum(composite(fg.rgb, fg.alpha, bg.rgb));
  const lo = lum(bg.rgb);
  return (Math.max(hi, lo) + 0.05) / (Math.min(hi, lo) + 0.05);
}

const ratio =
  (scope: Map<string, string>, bg: string) =>
  (fg: string): number =>
    ratioOf(fg, bg, scope);

for (const theme of ["dark", "light"] as const) {
  // The light block only overrides; anything it does not name (the accent,
  // which follows the lit rung) inherits the base ladder.
  const scope = theme === "dark" ? dark : new Map([...dark, ...light]);
  const page = scope.get("--color-page")!;
  const raised = scope.get("--color-raised")!;
  const lit = scope.get("--color-lit")!;
  const on = ratio(scope, page);

  test(`${theme}: essential text clears WCAG AA on the page ground`, () => {
    expect(on(scope.get("--color-text")!), "text/page").toBeGreaterThanOrEqual(7);
    expect(on(scope.get("--color-label-secondary")!), "secondary/page").toBeGreaterThanOrEqual(4.5);
    expect(on(scope.get("--color-muted")!), "muted/page").toBeGreaterThanOrEqual(4.5);
    // The accent defaults to the lit rung, so an accent-coloured label is a
    // bright label, not a hue to squint at.
    expect(on("var(--color-accent)"), "accent/page").toBeGreaterThanOrEqual(4.5);
    expect(ratioOf(scope.get("--color-on-lit")!, lit, scope), "on-lit/lit").toBeGreaterThanOrEqual(
      4.5,
    );
    // Error text on a raised card (dialogs, permission cards) is AA.
    expect(
      ratioOf(scope.get("--color-danger")!, raised, scope),
      "danger/raised",
    ).toBeGreaterThanOrEqual(4.5);
  });

  test(`${theme}: status hues stay legible on the page ground`, () => {
    // Warning/success/info/danger colour small status labels and glyphs; the
    // floor is the 3:1 UI-component floor with margin, not AA body text.
    // Measured values live in docs/astra/A11Y.md; a drop below the floor
    // means a status colour stopped reading as text at all.
    for (const name of ["--color-danger", "--color-warning", "--color-success", "--color-info"])
      expect(on(scope.get(name)!), `${name}/page`).toBeGreaterThanOrEqual(4.0);
  });

  test(`${theme}: faint is decorative-only and never vanishes`, () => {
    // --color-faint sets placeholders, captions and decorative marks, never
    // essential labels. The floor only guards against it going invisible
    // (e.g. an alpha dropped to near zero); its AA exemption is documented
    // in docs/astra/A11Y.md, which restricts it to non-essential use.
    expect(on(scope.get("--color-faint")!), "faint/page").toBeGreaterThanOrEqual(2.5);
  });
}

test("high-contrast axis raises muted text to full text", () => {
  // data-contrast="true" is the in-app accessibility switch: muted and faint
  // become the text colour outright, and hairlines become the strong border.
  expect(contrastCss).toContain("--color-muted: var(--color-text)");
  expect(contrastCss).toContain("--color-faint: var(--color-text)");
  expect(contrastCss).toContain("--color-border: var(--color-border-strong)");
});

test("reduced motion is honoured by stylesheet and setting", () => {
  // Both the OS preference and the in-app ui.reduce-motion setting collapse
  // durations to a frame (not zero, so transitionend/animationend still fire).
  expect(motionCss).toContain("@media (prefers-reduced-motion: reduce)");
  expect(motionCss).toContain('[data-reduce-motion="true"]');
  expect(motionCss).toContain("transition-duration: 0.01ms !important");
  expect(motionCss).toContain("animation-duration: 0.01ms !important");
});

test("forced-colors support is present in the chrome and key controls", () => {
  const occurrences = globalCss.match(/@media \(forced-colors: active\)/g) ?? [];
  expect(occurrences.length, "global forced-colors blocks").toBeGreaterThanOrEqual(3);
  // Focus must stay perceivable without colour: the forced-colors ring.
  expect(globalCss).toContain("outline: 2px solid Highlight");
  for (const component of [
    "Button/Button.svelte",
    "Checkbox/Checkbox.svelte",
    "Chip/Chip.svelte",
    "SearchField/SearchField.svelte",
    "SegmentedControl/SegmentedControl.svelte",
    "AudioControl/AudioControl.svelte",
    "Badge/Badge.svelte",
    "CaptureControl/CaptureControl.svelte",
    "SettingsGroup/SettingsGroup.svelte",
  ]) {
    const source = readFileSync(new URL(`../shared/ui/${component}`, root), "utf8");
    expect(source, component).toContain("forced-colors");
  }
  // Select draws its panel and control from the shared menu/control sheets.
  for (const sheet of ["Menu/surface.css", "Button/control.css", "Shine/shine.css"]) {
    const source = readFileSync(new URL(`../shared/ui/${sheet}`, root), "utf8");
    expect(source, sheet).toContain("forced-colors");
  }
});
