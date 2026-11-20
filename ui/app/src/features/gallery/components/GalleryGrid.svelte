<script lang="ts">
  import type { GalleryItem } from "$shared/ipc/bindings";
  import * as m from "$shared/i18n/messages";
  import Button from "$shared/ui/Button";
  import type { GallerySession } from "../lib/gallery-session.svelte";
  import GalleryTile from "./GalleryTile.svelte";

  let {
    session,
    items,
    onopen,
  }: {
    session: GallerySession;
    /** The page's array, passed as a value: replacing it is what re-renders
     *  the grid, independently of the session object staying the same. */
    items: GalleryItem[];
    onopen: (item: GalleryItem, index: number, tile: HTMLElement | null) => void;
  } = $props();

  // The next page is fetched when the end of the grid is a screen away, so
  // scrolling stays continuous without mounting every picture at once.
  function watchMore(node: HTMLElement) {
    if (typeof IntersectionObserver !== "function") return {};
    const scroller = node.closest("[data-gallery-scroll]");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (session.scanning || session.next === null || session.loadingMore) return;
        void session.more();
      },
      {
        root: scroller instanceof HTMLElement ? scroller : null,
        rootMargin: "700px 0px",
      },
    );
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
</script>

<div class="grid" role="list">
  {#each items as item, index (item.path)}
    <div class="cell" role="listitem">
      <GalleryTile
        {item}
        src={session.thumbs.get(item.path)}
        failed={session.failed.has(item.path)}
        want={(wanted) => session.want(wanted)}
        onopen={(event) =>
          onopen(
            item,
            index,
            event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
          )}
      />
    </div>
  {/each}
</div>

{#if session.next !== null && !session.scanning}
  <div class="more" use:watchMore>
    <Button variant="secondary" disabled={session.loadingMore} onclick={() => void session.more()}
      >{m.gallery_show_more()}</Button
    >
  </div>
{/if}

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(138px, 1fr));
    gap: 12px;
    padding: 4px 2px 24px;
  }

  .cell {
    min-inline-size: 0;
  }

  .more {
    display: flex;
    justify-content: center;
    padding: 4px 0 28px;
  }

  @container (width < 620px) {
    .grid {
      grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
      gap: 8px;
    }
  }
</style>
