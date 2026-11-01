<script>
  import { onMount } from "svelte";
  import { createToolbar } from "./frame.js";
  import "./frame.css";

  // Toolbar row (P3-T03): frame-level actions under the titlebar.
  // onaction bubbles the chosen action id to the shell.
  let { actions = [], onaction = null } = $props();
  let mount;
  let api = $state(null);

  onMount(() => {
    const t = createToolbar(mount.ownerDocument, {
      actions,
      onAction: (id) => onaction?.(id),
    });
    mount.replaceWith(t.element);
    mount = t.element;
    api = t;
    return () => t.destroy();
  });

  export function setDisabled(id, disabled) {
    api?.setDisabled(id, disabled);
  }
</script>

<div class="astra-toolbar-mount" bind:this={mount}></div>
