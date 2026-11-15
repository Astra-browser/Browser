import { describe, expect, it } from "vitest";
import { layout } from "../lib/layout";

const FULL = { controls: [32, 32], clock: true };

describe("layout", () => {
  it("stands the name in the open sky, the day under it and the field last", () => {
    const page = layout(1200, 800, FULL);
    expect(page.horizon).toBe(480);
    // The name keeps the wordmark's own 3.2:1 ratio: 84 tall, 270 wide.
    expect(page.mark.h).toBe(84);
    expect(page.mark.w).toBe(270);
    expect(page.mark.w / page.mark.h).toBeCloseTo(3.22, 1);
    expect(page.mark.x + page.mark.w / 2).toBeCloseTo(600, 0);
    expect(page.when).toBe(page.mark.y + page.mark.h + 14);
    expect(page.when! + 20).toBeLessThan(page.horizon - 40);
  });

  it("puts one wide field under the line, centred and on the page", () => {
    const page = layout(1200, 800, FULL);
    expect(page.field.w).toBe(560);
    expect(page.field.x + page.field.w / 2).toBeCloseTo(600, 0);
    expect(page.field.y).toBeGreaterThan(page.when!);
    expect(page.field.y + page.field.h).toBeLessThan(800);
  });

  it("leaves the page uncut, so the ground is the whole rectangle", () => {
    expect(layout(1200, 800, FULL).notch.width).toBe(0);
  });

  it("gives each control its own round button in the top corner", () => {
    const page = layout(700, 800, FULL);
    expect(page.controls).toEqual([
      { x: 700 - 14 - 32 - 38, y: 9, w: 32, h: 32 },
      { x: 700 - 14 - 32, y: 9, w: 32, h: 32 },
    ]);
  });

  it("gives words a capsule as wide as they are, and keeps the corner where it was", () => {
    const page = layout(700, 800, { ...FULL, controls: [64, 32] });
    expect(page.controls).toEqual([
      { x: 700 - 14 - 32 - 6 - 64, y: 9, w: 64, h: 32 },
      { x: 700 - 14 - 32, y: 9, w: 32, h: 32 },
    ]);
    // The fields stay centred whatever the corner holds.
    expect(page.field.x + page.field.w / 2).toBeCloseTo(350, 0);
  });

  it("closes up around what is not shown", () => {
    const page = layout(1200, 800, { controls: [], clock: false });
    expect(page.controls).toEqual([]);
    expect(page.when).toBeNull();
  });

  it("never lets the name ride up under the title band on a short page", () => {
    expect(layout(1200, 300, FULL).mark.y).toBeGreaterThanOrEqual(48);
  });
});

it("removes the wordmark's height and clock gap and leaves the controls where they were", () => {
  const normal = layout(1200, 800, FULL);
  const hidden = layout(1200, 800, { ...FULL, wordmark: false });
  expect(hidden.mark.h).toBe(0);
  expect(hidden.when).toBe(hidden.mark.y);
  expect(hidden.when).toBeLessThan(normal.when!);
  expect(hidden.controls).toEqual(normal.controls);
  expect(hidden.notch).toEqual(normal.notch);
  expect(layout(1200, 800, { ...FULL, wordmark: false, clock: false }).when).toBeNull();
});
