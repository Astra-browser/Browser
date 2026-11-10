<script lang="ts">
  /** Astra's app icon itself, its own paper ground included, the same in
   *  either theme. Drawn from the SVG master so it stays sharp at any size. */
  let { size = 16 }: { size?: number } = $props();
</script>

<img
  class="astra-tile"
  src="astra-icon.svg"
  width={size}
  height={size}
  alt=""
  aria-hidden="true"
  draggable="false"
/>

<style>
  .astra-tile {
    display: inline-block;
    flex: none;
    object-fit: contain;
  }
</style>
