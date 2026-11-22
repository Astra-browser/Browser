/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";
import { createSlice, listenAll } from "../lifecycle";

describe("slice lifecycle", () => {
  it("shares an init and releases a listener that arrives after dispose", async () => {
    let resolveListen!: (stop: () => void) => void;
    const stop = vi.fn();
    const slice = createSlice({
      register: () => new Promise<() => void>((resolve) => (resolveListen = resolve)),
    });
    const first = slice.init();
    expect(slice.init()).toBe(first);
    slice.dispose();
    resolveListen(stop);
    await first;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("reinitializes after dispose and tolerates a second dispose", async () => {
    const stops: (() => void)[] = [];
    const slice = createSlice({
      register: () => {
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      },
      reset: vi.fn(),
    });
    await slice.init();
    expect(slice.ready()).toBe(true);
    slice.dispose();
    expect(stops[0]).toHaveBeenCalledOnce();
    await slice.init();
    expect(slice.ready()).toBe(true);
    expect(stops).toHaveLength(2);
    slice.dispose();
    expect(stops[1]).toHaveBeenCalledOnce();
    expect(() => slice.dispose()).not.toThrow();
    expect(stops[1]).toHaveBeenCalledOnce();
  });

  it("stays unready when the register returns no listener", async () => {
    const slice = createSlice({ register: () => undefined });
    await slice.init();
    expect(slice.ready()).toBe(false);
    await slice.init();
    expect(slice.ready()).toBe(false);
  });

  it("rejects callbacks from disposed and superseded generations", async () => {
    let current!: () => boolean;
    const slice = createSlice({
      register({ isCurrent }) {
        current = isCurrent;
        return () => {};
      },
    });
    const generation = slice.current();
    await slice.init();
    expect(current()).toBe(true);
    slice.dispose();
    expect(current()).toBe(false);
    expect(slice.isCurrent(generation)).toBe(false);
  });
});

describe("listenAll", () => {
  it("releases registrations even when another registration rejects first", async () => {
    const stop = vi.fn();
    let register!: (stop: () => void) => void;
    const pending = listenAll([
      Promise.reject(new Error("registration failed")),
      new Promise<() => void>((resolve) => {
        register = resolve;
      }),
    ]);
    const rejected = expect(pending).rejects.toThrow("registration failed");
    register(stop);
    await rejected;
    expect(stop).toHaveBeenCalledOnce();
  });
});

it("releases remaining listeners if an earlier cleanup throws", async () => {
  const stop = vi.fn();
  await expect(
    listenAll([
      Promise.resolve(() => {
        throw new Error("cleanup failed");
      }),
      Promise.resolve(stop),
      Promise.reject(new Error("registration failed")),
    ]),
  ).rejects.toThrow("registration failed");
  expect(stop).toHaveBeenCalledOnce();
});
