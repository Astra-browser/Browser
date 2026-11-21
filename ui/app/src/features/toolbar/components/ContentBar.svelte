<script lang="ts">
  import type { Snippet } from "svelte";
  import PageNav from "./PageNav.svelte";
  import { WindowControlsInline } from "$shared/ui/WindowControls";
  import { IS_WINDOWS } from "$shared/platform";

  // The bar belongs to the content column, not the sidebar: it stands above
  // the page and carries the page's own controls. The field itself is the
  // product's one address field, composed by the app and placed here; this
  // wrapper never restyles it.
  //
  // When the column's head owns the field, the bar keeps only the window's own
  // controls (Windows), so the bar's whole role here is that trailing cluster.
  //
  // On Windows the window's own minimise/maximise/close live at this bar's
  // trailing end: the bar is the horizontal top panel, so they are part of it
  // rather than a capsule on top of the page. Elsewhere the platform's own
  // arrangement applies (macOS traffic lights, Linux's overlay cluster).
  let {
    field,
    nav = true,
  }: {
    field?: Snippet;
    /** The page's controls. Left out where the column's head already draws them. */
    nav?: boolean;
  } = $props();
</script>

<div class="content-bar" data-content-bar>
  {#if nav}<PageNav />{/if}
  {#if field}
    <div class="content-bar-field">{@render field()}</div>
  {:else}
    <span class="content-bar-gap" aria-hidden="true"></span>
  {/if}
  {#if IS_WINDOWS}<WindowControlsInline />{/if}
</div>

<style>
  /* The bar is the page's own band: the window ground shows through, and only
     the controls stand on it. It never takes the page's room, so the card
     below it keeps the column's whole width. */
  .content-bar {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    block-size: var(--main-bar-height);
    padding-inline: var(--main-bar-inset);
    min-inline-size: 0;
  }

  /* The field keeps its own shape; the wrapper only says where it stands and
     how wide it may grow. It is a block so the field's own form fills the
     width, as it did in the column. The frozen field carries an 8px trailing
     gap for the store card it can show below itself; cancelling it here
     centres the 34px field in the 40px bar without touching the field. */
  .content-bar-field {
    display: block;
    flex: 1 1 auto;
    min-inline-size: 0;
    max-inline-size: 720px;
    margin-inline: auto;
    margin-block-end: calc(-1 * var(--main-bar-inset));
  }

  /* Without a field the bar holds only the window's controls, which stay at
     the trailing end. */
  .content-bar-gap {
    flex: 1 1 auto;
    min-inline-size: 0;
  }

  /* Window controls belong to the panel, and come to the hand when it is on
     the panel: at rest they are only the shapes in the right corner, and a
     hover (or keyboard focus) brings them out. A touch screen has no hover, so
     there they are simply present. */
  .content-bar :global(.window-controls-inline) {
    opacity: 0;
    translate: 0 -2px;
    pointer-events: none;
    transition:
      opacity var(--motion-fast) var(--ease-out),
      translate var(--motion-fast) var(--ease-out);
  }

  .content-bar:hover :global(.window-controls-inline),
  .content-bar:focus-within :global(.window-controls-inline) {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }

  @media (hover: none) {
    .content-bar :global(.window-controls-inline) {
      opacity: 1;
      translate: 0 0;
      pointer-events: auto;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .content-bar :global(.window-controls-inline) {
      transition: none;
    }
  }

  @media (forced-colors: active) {
    .content-bar {
      border-block-end: 1px solid CanvasText;
    }
  }
</style>
