<script lang="ts">
  import type { GalleryItem } from "$shared/ipc/bindings";
  import { Image02Icon } from "@hugeicons/core-free-icons";
  import Icon from "$shared/ui/Icon";

  let {
    item,
    src = undefined,
    failed = false,
    onopen,
    want,
  }: {
    item: GalleryItem;
    src?: string;
    failed?: boolean;
    onopen: (event: MouseEvent) => void;
    want: (item: GalleryItem) => void;
  } = $props();

  // Only a tile near the viewport asks for its picture. The observer is
  // disconnected as soon as the request is made, so scrolling back over a
  // gallery never starts a second decode.
  function near(node: HTMLElement) {
    if (typeof IntersectionObserver !== "function") {
      want(item);
      return {};
    }
    const scroller = node.closest("[data-gallery-scroll]");
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        want(item);
      },
      {
        root: scroller instanceof HTMLElement ? scroller : null,
        rootMargin: "520px 0px",
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

<button
  type="button"
  class="tile"
  use:near
  data-gallery-tile
  data-path={item.path}
  title={item.name}
  aria-label={item.name}
  onclick={onopen}
>
  <span class="frame">
    {#if src}
      <img class="photo" {src} alt="" decoding="async" loading="lazy" draggable="false" />
    {:else if failed}
      <span class="missing"><Icon icon={Image02Icon} size={22} /></span>
    {:else}
      <span class="waiting" aria-hidden="true"></span>
    {/if}
  </span>
</button>

<style>
  .tile {
    display: block;
    box-sizing: border-box;
    inline-size: 100%;
    aspect-ratio: 1;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--radius-card);
    background: transparent;
    cursor: default;
    outline: none;

    /* The browser skips layout and paint for a tile far outside the
       viewport; the intrinsic size keeps the scrollbar honest. */
    content-visibility: auto;
    contain-intrinsic-size: auto 168px;
  }

  .frame {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    inline-size: 100%;
    block-size: 100%;
    padding: 10px;
    overflow: hidden;
    border-radius: inherit;
    background: var(--color-field);
    transition:
      background-color var(--motion-fast) var(--ease-out),
      scale var(--motion-fast) var(--ease-out);
  }

  .tile:hover .frame {
    background: var(--row-active);
    scale: 1.025;
  }

  .tile:active .frame {
    scale: 0.99;
    transition-duration: var(--motion-instant);
  }

  .tile:focus-visible .frame {
    box-shadow: var(--shadow-field-focus);
  }

  .photo {
    display: block;
    max-inline-size: 100%;
    max-block-size: 100%;
    border-radius: var(--radius-inset);
    object-fit: contain;
    box-shadow: var(--shadow-card);
    pointer-events: none;
    animation: photo-in var(--motion-base) var(--ease-out) both;
  }

  @keyframes photo-in {
    from {
      opacity: 0;
      scale: 0.97;
    }
  }

  .waiting {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    border-radius: var(--radius-inset);
    background: linear-gradient(
      100deg,
      transparent 20%,
      color-mix(in srgb, var(--color-text) 7%, transparent) 45%,
      transparent 70%
    );
    background-size: 260% 100%;
    animation: waiting 1.7s ease-in-out infinite;
  }

  @keyframes waiting {
    from {
      background-position: 130% 0;
    }

    to {
      background-position: -130% 0;
    }
  }

  .missing {
    display: grid;
    place-items: center;
    color: var(--color-faint);
  }

  @media (prefers-reduced-motion: reduce) {
    .frame {
      transition: none;
    }

    .photo {
      animation: none;
    }

    .waiting {
      animation: none;
      background: var(--color-field);
      opacity: 0.5;
    }
  }
</style>
