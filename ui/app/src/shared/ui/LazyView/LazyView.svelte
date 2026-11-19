<script module lang="ts">
  import type { Component as SvelteComponent } from "svelte";
  // A loader names a view this window has already fetched, so its module is
  // still in memory. Remembering the resolved component lets a surface that is
  // unmounted by a tab switch (New Tab, its search field) mount straight from
  // the cache: without this every switch back painted the load state — a black
  // stage with "Loading" in its top-left corner — for a frame. Feature entries
  // export loaders as stable functions, so the loader is the cache key.
  // Module scope, not the instance: every LazyView in the window shares it.
  // It is a cache, never drawn from, so a SvelteMap would only add tracking.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain module cache
  const loadedViews = new Map<unknown, SvelteComponent<Record<string, unknown>>>();
</script>

<script lang="ts" generics="P extends Record<string, unknown>">
  import type { Component, Snippet } from "svelte";
  import { untrack } from "svelte";
  import RenderBoundary from "../RenderBoundary";
  let {
    loader,
    children,
    loadingLabel,
    failureLabel,
    retryLabel,
  }: {
    loader: () => Promise<{ default: Component<P> }>;
    children: Snippet<[Component<P>]>;
    loadingLabel: string;
    failureLabel: string;
    retryLabel: string;
  } = $props();
  let component = $state.raw<Component<P> | null>(
    untrack(() => (loadedViews.get(loader) as Component<P> | undefined) ?? null),
  );
  let failed = $state(false);
  let attempt = $state(0);
  $effect(() => {
    const load = loader;
    void attempt;
    failed = false;
    const known = (loadedViews.get(load) ?? null) as Component<P> | null;
    if (known) {
      component = known;
      return;
    }
    let current = true;
    component = null;
    void Promise.resolve()
      .then(() => (current ? load() : null))
      .then(
        (module) => {
          if (!current || !module) return;
          loadedViews.set(load, module.default as SvelteComponent<Record<string, unknown>>);
          component = module.default;
        },
        () => {
          if (current) failed = true;
        },
      );
    return () => {
      current = false;
    };
  });
</script>

{#if failed}
  <div class="load-state" role="alert">
    <p>{failureLabel}</p>
    <button type="button" onclick={() => attempt++}>{retryLabel}</button>
  </div>
{:else if component}
  <RenderBoundary title={failureLabel} {retryLabel}>
    {@render children(component)}
  </RenderBoundary>
{:else}
  <div class="load-state" role="status">{loadingLabel}</div>
{/if}

<style>
  .load-state {
    display: grid;
    justify-items: start;
    gap: 12px;
    padding: 16px;
    color: var(--color-text);
  }

  p {
    margin: 0;
  }

  button {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-row);
    padding: 6px 12px;
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
  }

  button:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
</style>
