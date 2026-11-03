import { afterEach, describe, expect, it, vi } from "vitest";

const scope = globalThis as unknown as { window?: unknown };

afterEach(() => {
  delete scope.window;
  vi.restoreAllMocks();
});

describe("window controls", () => {
  it("treats Firefox windowState 1 as maximized", async () => {
    scope.window = { parent: { windowState: 1 } };
    const { maximized } = await import("../window-control");
    expect(maximized()).toBe(true);
  });

  it("does not treat a minimized window (2) as maximized", async () => {
    scope.window = { parent: { windowState: 2 } };
    const { maximized } = await import("../window-control");
    expect(maximized()).toBe(false);
  });

  it("closes the chrome parent instead of asking the Host API model", async () => {
    const close = vi.fn();
    const dispatchWindowControl = vi.fn(async () => ({}));
    const parent = { close, __astraHost: { Frame: { dispatchWindowControl } } };
    scope.window = { parent, __astraHost: parent.__astraHost };
    const { windowAction } = await import("../window-control");
    windowAction("close");
    expect(close).toHaveBeenCalledTimes(1);
    expect(dispatchWindowControl).not.toHaveBeenCalled();
  });

  it("sends minimize through the shell's Frame dispatch", async () => {
    const dispatchWindowControl = vi.fn(async () => ({}));
    const parent = { __astraHost: { Frame: { dispatchWindowControl } } };
    scope.window = { parent, __astraHost: parent.__astraHost };
    const { windowAction } = await import("../window-control");
    windowAction("minimize");
    expect(dispatchWindowControl).toHaveBeenCalledWith({ action: "minimize" });
  });
});
