<script lang="ts">
  import Menu from "../Menu.svelte";
  import type { MenuEntry } from "../Menu.svelte";

  const entries: MenuEntry[] = [
    { kind: "heading", label: "Page" },
    { kind: "item", id: "copy", label: "Copy", hint: "Ctrl+C" },
    { kind: "item", id: "mute", label: "Mute Tab", disabled: true },
    { kind: "separator" },
    { kind: "item", id: "close", label: "Close Tab", danger: true },
  ];
</script>

<Menu label="Actions" {entries} onselect={() => {}}>
  {#snippet trigger()}Actions{/snippet}
</Menu>
