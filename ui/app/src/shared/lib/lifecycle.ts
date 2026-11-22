/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export type Unlisten = () => void;

/** Document-lifetime generation guard. Call begin only for a new initialization. */
export function createLifecycle() {
  let generation = 0;
  let active = false;
  return {
    begin() {
      active = true;
      return ++generation;
    },
    isCurrent(value: number) {
      return active && generation === value;
    },
    end() {
      active = false;
      generation++;
    },
  };
}

/** A slice registers one listener or a set of them; returning nothing means it
 *  is not listening yet and a later `init()` must try again. */
export type SliceRegistration = Unlisten | readonly Unlisten[] | undefined;

export type SliceContext = {
  readonly generation: number;
  /** True while this registration still owns the slice. */
  isCurrent(): boolean;
  /** The current generation, for code that starts its own bounded work. */
  current(): number;
  /** Install the listener release as soon as the registration exists, so a
   *  dispose during a long startup still releases it immediately. */
  attach(stop: Unlisten): void;
};

export type Slice = {
  init(): Promise<void>;
  dispose(): void;
  isCurrent(generation: number): boolean;
  current(): number;
};

export type SliceOptions = {
  /** The slice's synchronous setup and subscriptions. May await; the generation
   *  and `isCurrent` guard every callback. */
  register(context: SliceContext): SliceRegistration | Promise<SliceRegistration>;
  /** Reset the slice's own state after the generation is invalidated and its
   *  listeners released. Runs on every dispose, including a second one. */
  reset?(): void;
  /** Re-apply state when `init()` is called after the slice is already live. */
  whenInitialized?(): void;
};

/**
 * The one document-lifetime contract for a UI slice: `init` resolves once, a
 * dispose releases whatever was registered (even mid-initialization), and a
 * later `init` starts a new generation. Framework-free so it can be tested
 * without Svelte.
 */
export function createSlice(options: SliceOptions): Slice {
  let generation = 0;
  let initialized = false;
  let initializing: Promise<void> | null = null;
  let unlisten: Unlisten | null = null;

  function release(registration: SliceRegistration) {
    if (registration === undefined) return;
    if (typeof registration === "function") registration();
    else for (const stop of registration) stop();
  }

  function init(): Promise<void> {
    if (initializing !== null) return initializing;
    if (initialized) {
      options.whenInitialized?.();
      return Promise.resolve();
    }

    const owner = ++generation;
    const context: SliceContext = {
      generation: owner,
      isCurrent: () => generation === owner,
      current: () => generation,
      attach(stop) {
        if (generation !== owner) {
          stop();
          return;
        }
        unlisten?.();
        unlisten = stop;
      },
    };

    const task = (async () => {
      const registration = await options.register(context);
      if (generation !== owner) {
        // A dispose already ran. Release a listener that arrived late; an
        // earlier `attach` was released by that dispose.
        if (registration !== undefined && unlisten === null) release(registration);
        return;
      }
      if (registration !== undefined && unlisten === null) {
        unlisten = () => release(registration);
      }
      if (unlisten !== null) initialized = true;
    })();

    initializing = task;
    void task.then(
      () => {
        if (initializing === task) initializing = null;
      },
      () => {
        if (initializing === task) initializing = null;
      },
    );
    return task;
  }

  function dispose() {
    generation += 1;
    initialized = false;
    initializing = null;
    const stop = unlisten;
    unlisten = null;
    stop?.();
    options.reset?.();
  }

  return {
    init,
    dispose,
    isCurrent: (value: number) => generation === value,
    current: () => generation,
  };
}

/** Registrations start at the call site, before await. Partial failures release all successes. */
export async function listenAll(promises: readonly Promise<Unlisten>[]): Promise<Unlisten[]> {
  const results = await Promise.allSettled(promises);
  const listeners: Unlisten[] = [];
  let failure: PromiseRejectedResult | undefined;
  for (const result of results) {
    if (result.status === "fulfilled") listeners.push(result.value);
    else failure ??= result;
  }
  if (failure) {
    for (const stop of listeners) {
      try {
        stop();
      } catch {
        /* Continue releasing siblings; report the original registration failure. */
      }
    }
    throw failure.reason;
  }
  return listeners;
}
