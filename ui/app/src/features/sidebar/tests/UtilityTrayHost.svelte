<script lang="ts">
  import UtilityTray from "../components/UtilityTray.svelte";

  let {
    warning = null,
    /** Stands in for the column the tray is mounted in: the tray reads the
     *  pointer state the app publishes on it. */
    pointerIn = false,
  }: { warning?: string | null; pointerIn?: boolean } = $props();
</script>

<div class="browser-sidebar" data-pointer-in={pointerIn || undefined}>
  <UtilityTray label="Site information" {warning}>
    {#snippet children(open)}
      <section aria-label="Section">
        <button type="button">Inside</button>
        <output>{open ? "showing" : "hidden"}</output>
      </section>
    {/snippet}
  </UtilityTray>
</div>
