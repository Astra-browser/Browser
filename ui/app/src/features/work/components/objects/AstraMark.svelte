<script module lang="ts">
  /** Whether a name is Astra itself, which has no site mark to borrow. */
  export const isAstra = (name: string) => /^astra\b/iu.test(name.trim());
</script>

<script lang="ts">
  import AstraTile from "$shared/ui/AstraTile";

  let { size = 16 }: { size?: number } = $props();
</script>

<AstraTile {size} />
