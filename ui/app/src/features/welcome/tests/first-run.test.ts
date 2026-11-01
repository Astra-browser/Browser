import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  COMPLETED_KEY,
  THEMES,
  THEME_KEY,
  isFirstRun,
  isThemeChoice,
  persistWelcome,
  readTheme,
  type ThemeChoice,
} from "../index";

const native = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  refused: new Set<string>(),
}));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({
    settingGet: async (key: string) => native.settings[key] ?? null,
    settingSet: async (key: string, value: string) => {
      if (native.refused.has(key)) return { accepted: false, operation_id: null };
      native.settings[key] = value;
      return { accepted: true, operation_id: null };
    },
  });
});

beforeEach(() => {
  native.settings = {};
  native.refused.clear();
});

describe("first-run flag", () => {
  test("a fresh bridge means first run", async () => {
    await expect(isFirstRun()).resolves.toBe(true);
  });

  test("a completed flag means no first run", async () => {
    native.settings[COMPLETED_KEY] = "true";
    await expect(isFirstRun()).resolves.toBe(false);
  });

  test("persisting the run records the theme and the flag", async () => {
    const choice: ThemeChoice = "dark";
    expect(THEMES).toContain(choice);
    await persistWelcome(choice);
    expect(native.settings[THEME_KEY]).toBe("dark");
    expect(native.settings[COMPLETED_KEY]).toBe("true");
  });

  test("a refused bridge write fails the run instead of half-saving it", async () => {
    native.refused.add(COMPLETED_KEY);
    await expect(persistWelcome("light")).rejects.toThrow(COMPLETED_KEY);
    expect(native.settings[COMPLETED_KEY]).toBeUndefined();
  });
});

describe("theme choice", () => {
  test("only system, light, and dark are choices", () => {
    expect(isThemeChoice("dark")).toBe(true);
    expect(isThemeChoice("neon")).toBe(false);
    expect(isThemeChoice(null)).toBe(false);
  });

  test("the stored theme is read, defaulting to system", async () => {
    await expect(readTheme()).resolves.toBe("system");
    native.settings[THEME_KEY] = "light";
    await expect(readTheme()).resolves.toBe("light");
  });

  test("a bogus stored theme falls back to system", async () => {
    native.settings[THEME_KEY] = "neon";
    await expect(readTheme()).resolves.toBe("system");
  });
});
