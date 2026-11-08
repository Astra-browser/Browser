<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { peek } from "$domain/peek";

  const SIZES: Record<string, number> = { small: 260, medium: 340, large: 440 };
  const leaving = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  let layer = $state<HTMLElement | undefined>();

  function postShell(message: Record<string, unknown>): void {
    try {
      if (!window.parent || window.parent === window) return;
      window.parent.postMessage({ ns: "astra-shell", ...message }, "*");
    } catch {
      // No shell: standalone previews still draw the card.
    }
  }

  /** The frame is under the page; tell the shell which rectangle to reveal. */
  function announce(open: boolean): void {
    if (!open || !layer) {
      postShell({ kind: "peek-close" });
      return;
    }
    void tick().then(() => {
      if (!layer) return;
      const cards = [...layer.querySelectorAll<HTMLElement>(".peek-card")];
      if (cards.length === 0) {
        postShell({ kind: "peek-close" });
        return;
      }
      const boxes = cards.map((card) => card.getBoundingClientRect());
      const top = Math.min(...boxes.map((box) => box.top));
      const left = Math.min(...boxes.map((box) => box.left));
      const right = window.innerWidth - Math.max(...boxes.map((box) => box.right));
      const bottom = window.innerHeight - Math.max(...boxes.map((box) => box.bottom));
      postShell({ kind: "peek-open", rect: { top, left, right, bottom } });
    });
  }

  $effect(() => {
    const open = peek.state().length > 0;
    untrack(() => {
      document.documentElement.dataset.astraPagePeek = open ? "true" : "";
      announce(open);
    });
  });

  function width(): number {
    return (SIZES[peek.settings().size] ?? SIZES.medium!) * (peek.settings().scale || 1);
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function hold(id: string): void {
    const timer = leaving.get(id);
    if (timer) clearTimeout(timer);
    leaving.delete(id);
  }

  function release(id: string): void {
    if (!peek.settings().closeOnLeave) return;
    hold(id);
    const timer = setTimeout(() => peek.close(id), 260);
    leaving.set(id, timer);
  }

  function close(id: string): void {
    hold(id);
    peek.close(id);
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const cards = peek.state();
      if (cards.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      peek.close(cards[cards.length - 1]!.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const timer of leaving.values()) clearTimeout(timer);
      leaving.clear();
      delete document.documentElement.dataset.astraPagePeek;
      postShell({ kind: "peek-close" });
    };
  });
</script>

{#if peek.state().length > 0}
  <div
    bind:this={layer}
    class="peek-layer"
    data-position={peek.settings().position}
    aria-live="polite"
    aria-label="Page previews"
  >
    {#each peek.state() as entry (entry.id)}
      <aside
        class="peek-card"
        data-peek-id={entry.id}
        aria-label={`Preview of ${entry.title}`}
        style:--peek-width={`${width()}px`}
        onmouseenter={() => hold(entry.id)}
        onmouseleave={() => release(entry.id)}
        onfocusin={() => hold(entry.id)}
        onfocusout={() => release(entry.id)}
      >
        <header class="peek-head">
          {#if peek.settings().showTitle}
            <span class="peek-title" title={entry.title}>{entry.title}</span>
          {:else}
            <span class="peek-title" aria-hidden="true"></span>
          {/if}
          <button
            type="button"
            class="peek-close"
            aria-label="Close preview"
            title="Close preview"
            onclick={() => close(entry.id)}>×</button
          >
        </header>
        <div class="peek-media" class:empty={!entry.image && !entry.thumbnail}>
          {#if entry.image}
            <img src={entry.image} alt="" draggable="false" />
          {:else if entry.thumbnail}
            <img src={entry.thumbnail} alt="" draggable="false" />
          {:else}
            <span class="peek-placeholder" aria-hidden="true">
              {hostOf(entry.url).slice(0, 1).toUpperCase()}
            </span>
          {/if}
          {#if entry.private}<span class="peek-private">Private</span>{/if}
        </div>
        {#if peek.settings().showUrl}
          <p class="peek-url">{hostOf(entry.url)}</p>
        {/if}
        <footer class="peek-actions">
          <button type="button" onclick={() => peek.openTab(entry.id)}>Open as Tab</button>
          <button type="button" class="peek-split" onclick={() => peek.openSplit(entry.id)}>
            Open in Split View
          </button>
        </footer>
      </aside>
    {/each}
  </div>
{/if}

<style>
  .peek-layer {
    position: fixed;
    inset-block-end: 24px;
    inset-inline-end: 24px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 10px;
    align-items: flex-end;
    pointer-events: none;
  }

  .peek-layer[data-position="bottom-left"] {
    inset-inline: 24px auto;
    align-items: flex-start;
  }

  .peek-layer[data-position="top-right"] {
    inset-block: 64px auto;
  }

  .peek-layer[data-position="top-left"] {
    inset-block: 64px auto;
    inset-inline: 24px auto;
    align-items: flex-start;
  }

  .peek-card {
    inline-size: var(--peek-width, 340px);
    max-inline-size: calc(100vw - 48px);
    pointer-events: auto;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    box-shadow: var(--shadow-card);
    animation: peek-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .peek-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 6px 12px;
    min-block-size: 34px;
  }

  .peek-title {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    font-size: 12px;
    font-weight: 600;
  }

  .peek-close {
    flex: none;
    inline-size: 22px;
    block-size: 22px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--color-muted);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
  }

  .peek-close:hover,
  .peek-close:focus-visible {
    background: var(--color-control-hover);
    color: var(--color-text);
  }

  .peek-media {
    position: relative;
    margin-inline: 8px;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--color-surface);
    aspect-ratio: 16 / 10;
  }

  .peek-media img {
    inline-size: 100%;
    block-size: 100%;
    object-fit: cover;
    object-position: top center;
    display: block;
  }

  .peek-media.empty {
    display: grid;
    place-items: center;
    background:
      radial-gradient(120% 120% at 20% 0%, var(--color-fill-hover), transparent 60%),
      var(--color-surface);
  }

  .peek-placeholder {
    color: var(--color-faint);
    font-size: 32px;
    font-weight: 600;
  }

  .peek-private {
    position: absolute;
    inset-block-start: 6px;
    inset-inline-start: 6px;
    padding: 2px 6px;
    border-radius: 999px;
    background: var(--color-menu);
    color: var(--color-label-secondary);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .peek-url {
    margin: 6px 12px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-faint);
    font-size: 11px;
  }

  .peek-actions {
    display: flex;
    gap: 6px;
    padding: 8px;
  }

  .peek-actions button {
    flex: 1;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
    font-size: 11px;
    padding: 6px 8px;
    cursor: pointer;
    transition:
      background var(--motion-fast) var(--ease-out),
      border-color var(--motion-fast) var(--ease-out),
      transform var(--motion-fast) var(--ease-out);
  }

  .peek-actions button:hover {
    background: var(--color-fill-hover);
    border-color: var(--color-border-strong);
  }

  .peek-actions button:active {
    background: var(--color-fill-pressed);
    transform: scale(0.98);
  }

  .peek-actions .peek-split {
    background: var(--color-control);
  }

  @keyframes peek-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }

    to {
      opacity: 1;
      transform: none;
    }
  }

  :global([data-reduce-motion="true"]) .peek-card {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .peek-card {
      animation: none;
    }

    .peek-actions button {
      transition: none;
    }
  }
</style>
