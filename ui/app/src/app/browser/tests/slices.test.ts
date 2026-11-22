/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

// One fake transport for every sliced event: each `listen` resolves with a
// stop spy unless a test asks the next registration to stay pending, which is
// how a dispose can land before a listener exists.
const native = vi.hoisted(() => {
  type Deferred = { stop: () => void; resolve: () => void };
  const state = {
    listens: [] as (() => void)[],
    stopCalls: 0,
    deferred: null as Deferred | null,
    deferNext: false,
  };
  const listen = vi.fn(() => {
    const stop = vi.fn(() => {
      state.stopCalls += 1;
    });
    state.listens.push(stop);
    if (state.deferNext) {
      state.deferNext = false;
      return new Promise<() => void>((resolve) => {
        state.deferred = { stop, resolve: () => resolve(stop) };
      });
    }
    return Promise.resolve(stop);
  });
  const events = new Proxy(
    {},
    {
      get(_target, key) {
        return key === "then" ? undefined : { listen };
      },
    },
  );
  return { state, listen, events };
});

vi.mock("$shared/ipc/native-events", () => ({
  events: native.events,
  nativeEventNames: {},
}));

vi.mock("$shared/ipc/bindings", async () => {
  const { mockBindings } = await import("$shared/testing/bindings");
  // The model file only: the public barrel also loads `blocker.svelte`, which
  // imports the bindings module this factory is still building, so importing
  // the barrel here deadlocks the mock.
  const { initialBlockerStatus } = await import("$domain/blocker/blocker-model");
  return mockBindings({
    uiInfo: async () => ({ material: "none", materials: [] }),
    settingGet: async () => null,
    settingSet: async () => ({ accepted: true, operation_id: null }),
    operationsReconcile: async () => [],
    operationAcknowledge: async () => true,
    operationStatus: async () => ({ state: "unknown" }),
    tabsBootstrap: async () => {},
    keymapEntries: async () => [],
    blockerStatus: async () => ({
      status: "ok",
      data: { ...initialBlockerStatus(), projection_revision: "1".repeat(32) },
    }),
  });
});

// `theme.ts` resolves its media query and document root at module load. The
// unit project runs in Node, so give those modules the browser surface they
// read without bringing in a DOM implementation.
function installBrowserGlobals(): void {
  const root = {
    dataset: {} as Record<string, string>,
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {},
    removeAttribute() {},
  };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const windowLike: Record<string, unknown> = {
    matchMedia: () => media,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => "", backgroundColor: "" }),
  };
  windowLike.parent = windowLike;
  Object.assign(globalThis, {
    window: windowLike,
    document: {
      documentElement: root,
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    getComputedStyle: windowLike.getComputedStyle,
  });
}

installBrowserGlobals();
const { browserSlices } = await import("../slices");

beforeEach(() => {
  native.listen.mockClear();
  native.state.listens = [];
  native.state.stopCalls = 0;
  native.state.deferred = null;
  native.state.deferNext = false;
});

describe.each(browserSlices)("$id lifecycle", ({ slice }) => {
  it("exposes the shared slice contract", () => {
    expect(typeof slice.init).toBe("function");
    expect(typeof slice.dispose).toBe("function");
    expect(typeof slice.isCurrent).toBe("function");
  });

  it("init twice shares one initialization and registers one set of listeners", async () => {
    slice.dispose();
    const first = slice.init();
    expect(slice.init()).toBe(first);
    await first;

    const registered = native.listen.mock.calls.length;
    expect(registered).toBeGreaterThan(0);

    await slice.init();
    expect(native.listen.mock.calls.length).toBe(registered);
    slice.dispose();
  });

  it("dispose during a pending init releases the late listener", async () => {
    slice.dispose();
    native.state.deferNext = true;
    const task = slice.init();
    expect(native.state.deferred).not.toBeNull();
    const deferred = native.state.deferred!;

    slice.dispose();
    deferred.resolve();
    await task;

    expect(deferred.stop).toHaveBeenCalledOnce();
    expect(native.state.stopCalls).toBe(native.listen.mock.calls.length);
  });

  it("dispose then init works again", async () => {
    slice.dispose();
    await slice.init();
    const registered = native.listen.mock.calls.length;
    slice.dispose();

    await slice.init();
    expect(native.listen.mock.calls.length).toBeGreaterThan(registered);
    slice.dispose();
  });

  it("dispose twice is safe and releases each listener once", async () => {
    slice.dispose();
    await slice.init();
    slice.dispose();
    const stopped = native.state.stopCalls;
    expect(stopped).toBe(native.listen.mock.calls.length);

    expect(() => slice.dispose()).not.toThrow();
    expect(native.state.stopCalls).toBe(stopped);
  });
});
