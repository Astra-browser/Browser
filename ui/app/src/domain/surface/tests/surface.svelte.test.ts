import { beforeEach, describe, expect, it, vi } from "vitest";
const harness = vi.hoisted(() => ({
  listener: null as null | ((event: { payload: string }) => void),
  items: null as null | ((event: { payload: { active: string | null } }) => void),
  run: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("svelte", () => ({ flushSync: (callback: () => void) => callback() }));
vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  return mockBindings({ runCommand: harness.run });
});
vi.mock("$domain/operations/operations", () => ({ waitForDisposition: harness.wait }));
vi.mock("$shared/ipc/native-events", () => ({
  events: {
    browserReturn: { listen: () => Promise.resolve(() => {}) },
    itemsChanged: {
      listen: (listener: typeof harness.items) => {
        harness.items = listener;
        return Promise.resolve(() => {});
      },
    },
    uiCommand: {
      listen: (listener: typeof harness.listener) => {
        harness.listener = listener;
        return Promise.resolve(() => {});
      },
    },
  },
}));
describe("browser destination failures", () => {
  beforeEach(() => {
    vi.resetModules();
    harness.listener = null;
    harness.run.mockReset();
    harness.wait.mockReset();
  });
  it("clears an earlier rejection when the native menu confirms Settings", async () => {
    const page = await import("../surface.svelte");
    await page.init();
    harness.run.mockResolvedValue({ accepted: false, operation_id: null });
    await page.open("settings");
    expect(page.navigationFailed()).toBe(true);
    harness.listener?.({ payload: "browser.settings" });
    expect(page.currentPage()).toBe("settings");
    expect(page.navigationFailed()).toBe(false);
    page.dispose();
  });
  it("does not replace a newer successful navigation with an old rejection", async () => {
    const page = await import("../surface.svelte");
    await page.init();
    let reject!: (error: Error) => void;
    harness.run.mockReturnValue(
      new Promise((_resolve, failure) => {
        reject = failure;
      }),
    );
    const pending = page.open("settings");
    harness.listener?.({ payload: "browser.settings" });
    reject(new Error("old request failed"));
    await pending;
    expect(page.currentPage()).toBe("settings");
    expect(page.navigationFailed()).toBe(false);
    page.dispose();
  });
});

it("shares initialization and does not report a disposed navigation as a new failure", async () => {
  const page = await import("../surface.svelte");
  const initializing = page.init();
  expect(page.init()).toBe(initializing);
  await initializing;
  harness.run.mockImplementation(() => new Promise(() => {}));
  const navigation = page.open("settings");
  page.dispose();
  await navigation;
  expect(page.currentPage()).toBeNull();
  expect(page.navigationFailed()).toBe(false);
});

describe("page tabs", () => {
  beforeEach(() => {
    vi.resetModules();
    harness.listener = null;
    harness.items = null;
    harness.run.mockReset();
    harness.run.mockResolvedValue({ accepted: true, operation_id: null });
  });
  it("parks the page when another tab comes forward and brings it back by its row", async () => {
    const page = await import("../surface.svelte");
    await page.init();
    harness.items?.({ payload: { active: "tab-1" } });
    harness.listener?.({ payload: "browser.settings" });
    expect(page.currentPage()).toBe("settings");
    expect(page.pageTab()).toBe("settings");
    // Choosing another tab gives it the window; the page keeps its own row.
    harness.items?.({ payload: { active: "tab-2" } });
    expect(page.currentPage()).toBeNull();
    expect(page.hasPage()).toBe(true);
    expect(page.pageTab()).toBe("settings");
    expect(page.pageTabSelected()).toBe(false);
    // Choosing the page row brings it back without touching the native tab.
    page.selectPage();
    expect(page.currentPage()).toBe("settings");
    expect(page.pageTabSelected()).toBe(true);
    // Closing from its row clears it rather than entering Work.
    await page.dismiss();
    harness.listener?.({ payload: "browser.return" });
    expect(page.hasPage()).toBe(false);
    expect(page.currentPage()).toBeNull();
    page.dispose();
  });
});

describe("closing a page", () => {
  beforeEach(() => {
    vi.resetModules();
    harness.listener = null;
    harness.run.mockReset();
    harness.run.mockResolvedValue({ accepted: true, operation_id: null });
  });
  it("returns to Work when the page was opened over it, and to Browse otherwise", async () => {
    const page = await import("../surface.svelte");
    await page.init();
    harness.listener?.({ payload: "browser.work" });
    harness.listener?.({ payload: "browser.settings" });
    await page.close();
    expect(harness.run).toHaveBeenLastCalledWith("browser.work");
    harness.listener?.({ payload: "browser.work" });
    harness.listener?.({ payload: "browser.return" });
    harness.listener?.({ payload: "browser.settings" });
    await page.close();
    expect(harness.run).toHaveBeenLastCalledWith("browser.return");
    page.dispose();
  });
});
