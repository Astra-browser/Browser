<script lang="ts">
  import type { Snippet } from "svelte";
  import PageNav from "./PageNav.svelte";

  // The bar belongs to the content column, not the sidebar: it stands above
  // the page and carries the page's own controls. The field itself is the
  // product's one address field, composed by the app and placed here; this
  // wrapper never restyles it.
  let { field }: { field: Snippet } = $props();
</script>

<div class="content-bar" data-content-bar>
  <PageNav />
  <div class="content-bar-field">{@render field()}</div>
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

  @media (forced-colors: active) {
    .content-bar {
      border-block-end: 1px solid CanvasText;
    }
  }
</style>
