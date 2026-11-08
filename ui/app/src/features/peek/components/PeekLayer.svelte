<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { peek } from "$domain/peek";

  const SIZES: Record<string, number> = { small: 420, medium: 620, large: 780 };
  const leaving = new SvelteMap<string, ReturnType<typeof setTimeout>>();
  const bookmarked = new SvelteSet<string>();
  let layer = $state<HTMLElement | undefined>();

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
      const cards = [...layer.querySelectorAll<HTMLElement>(".peek-window")];
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

  function hold(id: string): void {
    const timer = leaving.get(id);
    if (timer) clearTimeout(timer);
    leaving.delete(id);
  }

  function release(id: string): void {
    if (!peek.settings().closeOnLeave) return;
    hold(id);
    const timer = setTimeout(() => peek.discard(id), 260);
    leaving.set(id, timer);
  }

  function close(id: string): void {
    hold(id);
    bookmarked.delete(id);
    peek.discard(id);
  }

  async function bookmark(id: string): Promise<void> {
    if (bookmarked.has(id)) return;
    if (await peek.bookmark(id)) bookmarked.add(id);
  }

  function openTab(id: string): void {
    peek.openTab(id);
    bookmarked.delete(id);
    peek.discard(id);
  }

  function openSplit(id: string): void {
    peek.openSplit(id);
    bookmarked.delete(id);
    peek.discard(id);
  }

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const cards = peek.state();
      if (cards.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      close(cards[cards.length - 1]!.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      for (const timer of leaving.values()) clearTimeout(timer);
      leaving.clear();
      bookmarked.clear();
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
      <div
        class="peek-window"
        data-peek-id={entry.id}
        role="dialog"
        tabindex="-1"
        aria-label={`Preview of ${entry.title}`}
        style:--peek-width={`${width()}px`}
        onmouseenter={() => hold(entry.id)}
        onmouseleave={() => release(entry.id)}
        onfocusin={() => hold(entry.id)}
        onfocusout={() => release(entry.id)}
      >
        <header class="peek-titlebar">
          <span class="peek-mark" aria-hidden="true"></span>
          {#if peek.settings().showTitle}
            <span class="peek-title" title={entry.title}>{entry.title}</span>
          {:else}
            <span class="peek-title" aria-hidden="true"></span>
          {/if}
          <span class="peek-actions">
            <button
              type="button"
              class="peek-action"
              class:is-on={bookmarked.has(entry.id)}
              aria-label={bookmarked.has(entry.id) ? "Bookmarked" : "Bookmark this page"}
              title={bookmarked.has(entry.id) ? "Bookmarked" : "Bookmark this page"}
              aria-pressed={bookmarked.has(entry.id)}
              onclick={() => void bookmark(entry.id)}
            >
              {bookmarked.has(entry.id) ? "★" : "☆"}
            </button>
            <button
              type="button"
              class="peek-action"
              aria-label="Open in Split View"
              title="Open in Split View"
              onclick={() => openSplit(entry.id)}
            >
              ◫
            </button>
            <button
              type="button"
              class="peek-action"
              aria-label="Open as Tab"
              title="Open as Tab"
              onclick={() => openTab(entry.id)}
            >
              ↗
            </button>
            <button
              type="button"
              class="peek-action peek-close"
              aria-label="Close preview"
              title="Close preview"
              onclick={() => close(entry.id)}
            >
              ×
            </button>
          </span>
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
          <footer class="peek-foot">
            <span class="peek-url" title={entry.url}>{hostOf(entry.url)}</span>
            <span class="peek-foot-actions">
              <button type="button" onclick={() => openSplit(entry.id)}>Split View</button>
              <button type="button" onclick={() => openTab(entry.id)}>Open Tab</button>
            </span>
          </footer>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .peek-layer {
    position: fixed;
    inset-block-start: 64px;
    inset-inline-end: 24px;
    z-index: 60;
    display: flex;
    flex-direction: column;
    gap: 12px;
    align-items: flex-end;
    pointer-events: none;
  }

  .peek-layer[data-position="bottom-right"],
  .peek-layer[data-position="bottom-left"] {
    inset-block: auto 24px;
  }

  .peek-layer[data-position="bottom-left"],
  .peek-layer[data-position="top-left"] {
    inset-inline: 24px auto;
    align-items: flex-start;
  }

  .peek-layer[data-position="auto"] {
    inset-block-start: 68px;
    inset-inline-end: 32px;
  }

  .peek-window {
    inline-size: var(--peek-width, 620px);
    max-inline-size: calc(100vw - 48px);
    max-block-size: calc(100vh - 96px);
    display: flex;
    flex-direction: column;
    pointer-events: auto;
    overflow: hidden;
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-card);
    background: var(--color-raised);
    box-shadow: var(--shadow-card);
    animation: peek-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .peek-titlebar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-block-size: 38px;
    padding: 6px 8px 6px 12px;
    border-block-end: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .peek-mark {
    inline-size: 10px;
    block-size: 10px;
    flex: none;
    border-radius: 999px;
    background: var(--color-accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-accent) 18%, transparent);
  }

  .peek-title {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-text);
    font-size: 12px;
    font-weight: 600;
  }

  .peek-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 2px;
  }

  .peek-action {
    inline-size: 26px;
    block-size: 26px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--color-muted);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition:
      background var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out);
  }

  .peek-action:hover,
  .peek-action:focus-visible {
    background: var(--color-control-hover);
    color: var(--color-text);
  }

  .peek-action.is-on {
    color: var(--color-accent);
  }

  .peek-close:hover,
  .peek-close:focus-visible {
    background: var(--color-fill-pressed);
    color: var(--color-text);
  }

  .peek-media {
    position: relative;
    min-block-size: 0;
    margin: 8px;
    border-radius: var(--radius-control);
    overflow: hidden;
    background: var(--color-surface);
    aspect-ratio: 16 / 10;
    max-block-size: 58vh;
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
    font-size: 40px;
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

  .peek-foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px 10px;
  }

  .peek-url {
    flex: 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-faint);
    font-size: 11px;
  }

  .peek-foot-actions {
    display: flex;
    flex: none;
    gap: 4px;
  }

  .peek-foot-actions button {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control);
    background: var(--color-fill);
    color: var(--color-text);
    font: inherit;
    font-size: 10px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .peek-foot-actions button:hover {
    background: var(--color-fill-hover);
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

  :global([data-reduce-motion="true"]) .peek-window {
    animation: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .peek-window {
      animation: none;
    }

    .peek-action {
      transition: none;
    }
  }
</style>
