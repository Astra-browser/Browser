<script lang="ts">
  /** Astra's app icon itself, its own squircle and shadow included, the
   *  same in either theme. */
  let { size = 16 }: { size?: number } = $props();
</script>

<img
  class="astra-tile"
  src="/astra-icon.png"
  srcset="/astra-icon.png 128w, /astra-icon@2x.png 256w"
  sizes={`${size}px`}
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
