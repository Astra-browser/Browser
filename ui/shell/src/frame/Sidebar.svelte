<script>
  import { onMount } from "svelte";
  import { createSidebar } from "./frame.js";
  import "./frame.css";

  // Sidebar (P3-T03): vertical nav for spaces/library. Collapsible to a
  // 48px rail via data-collapsed. onselect bubbles the chosen item id.
  let { items = [], activeId = "", onselect = null } = $props();
  let mount;
  let api = $state(null);

  onMount(() => {
    const s = createSidebar(mount.ownerDocument, {
      items,
      activeId,
      onSelect: (id) => onselect?.(id),
    });
    mount.replaceWith(s.element);
    mount = s.element;
    api = s;
    return () => s.destroy();
  });

  export function select(id) {
    api?.select(id);
  }

  export function setCollapsed(collapsed) {
    api?.setCollapsed(collapsed);
  }
</script>

<div class="astra-sidebar-mount" bind:this={mount}></div>
