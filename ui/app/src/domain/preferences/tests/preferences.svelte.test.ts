import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  settle: vi.fn(),
  stop: vi.fn(),
  stopPreference: vi.fn(),
  listener: null as null | ((event: { payload: string }) => void),
  preferenceListener: null as null | ((event: { payload: { key: string; value: string } }) => void),
  listen: vi.fn(),
  listenPreference: vi.fn(),
}));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ settingGet: native.get, settingSet: native.set });
});
vi.mock("$domain/operations", () => ({ settle: native.settle }));
vi.mock("$shared/ipc/native-events", () => ({
  events: {
    uiCommand: { listen: native.listen },
    preferenceChanged: { listen: native.listenPreference },
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.resetAllMocks();
  native.listener = null;
  native.preferenceListener = null;
  native.listen.mockImplementation((listener: typeof native.listener) => {
    native.listener = listener;
    return Promise.resolve(native.stop);
  });
  native.listenPreference.mockImplementation((listener: typeof native.preferenceListener) => {
    native.preferenceListener = listener;
    return Promise.resolve(native.stopPreference);
  });
  native.get.mockResolvedValue(null);
  native.set.mockResolvedValue({ accepted: true, operation_id: "0000000000000001" });
  native.settle.mockResolvedValue({ outcome: "deferred", disposition: null });
});
afterEach(() => vi.useRealTimers());
describe("preference observation lifecycle", () => {
  it.each([null, "continue", "pages", "new-tab"])(
    "defaults startup to a new tab while preserving the stored choice %s",
    async (choice) => {
      native.get.mockImplementation(async (key: string) =>
        key === "tabs.startup" ? choice : null,
      );
      const preferences = await import("../preferences.svelte");
      await preferences.init();
      expect(preferences.value("tabs.startup")).toBe(choice ?? "new-tab");
      expect(native.set).not.toHaveBeenCalled();
      preferences.dispose();
    },
  );
  it("initializes once and keeps a live update ahead of an older startup read", async () => {
    const preferences = await import("../preferences.svelte");
    let finish!: (value: string) => void;
    native.get.mockImplementation((key: string) =>
      key === "ui.accent"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(null),
    );
    const first = preferences.init();
    expect(preferences.init()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    native.preferenceListener?.({ payload: { key: "ui.accent", value: "sage" } });
    finish("sky");
    await first;
    expect(native.listen).toHaveBeenCalledOnce();
    expect(native.listenPreference).toHaveBeenCalledOnce();
    expect(preferences.value("ui.accent")).toBe("sage");
    preferences.dispose();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(native.stopPreference).toHaveBeenCalledOnce();
  });
  it("resolves a write on the matching event with no re-read", async () => {
    const preferences = await import("../preferences.svelte");
    await preferences.init();
    native.get.mockClear();
    const pending = preferences.set("ui.accent", "sky");
    await Promise.resolve();
    native.preferenceListener?.({ payload: { key: "ui.accent", value: "sky" } });
    await pending;
    expect(preferences.saving()).toBe(false);
    expect(preferences.saveFailed()).toBe(false);
    expect(preferences.value("ui.accent")).toBe("sky");
    expect(native.get).not.toHaveBeenCalled();
    preferences.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("a lost event fails the write instead of fabricating a save", async () => {
    const preferences = await import("../preferences.svelte");
    await preferences.init();
    native.get.mockClear();
    const pending = preferences.set("ui.accent", "sky");
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(preferences.saving()).toBe(false);
    expect(preferences.saveFailed()).toBe(true);
    expect(preferences.value("ui.accent")).toBe("graphite");
    expect(native.get).not.toHaveBeenCalled();
    preferences.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("an event for another value does not settle the write", async () => {
    const preferences = await import("../preferences.svelte");
    await preferences.init();
    const pending = preferences.set("ui.accent", "sky");
    await Promise.resolve();
    native.preferenceListener?.({ payload: { key: "ui.accent", value: "rose" } });
    expect(preferences.saving()).toBe(true);
    native.preferenceListener?.({ payload: { key: "ui.accent", value: "sky" } });
    await pending;
    expect(preferences.saveFailed()).toBe(false);
    expect(preferences.value("ui.accent")).toBe("sky");
    preferences.dispose();
  });
  it("cancels a pending write on disposal without overwriting the next generation", async () => {
    const preferences = await import("../preferences.svelte");
    await preferences.init();
    const pending = preferences.set("ui.accent", "sky");
    await Promise.resolve();
    preferences.dispose();
    await pending;
    await preferences.init();
    expect(preferences.value("ui.accent")).toBe("graphite");
    expect(preferences.saveFailed()).toBe(false);
    preferences.dispose();
  });
});
