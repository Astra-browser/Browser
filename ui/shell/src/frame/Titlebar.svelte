<script>
  import { onMount } from "svelte";
  import { createTitlebar } from "./frame.js";
  import "./frame.css";

  // Custom titlebar (P3-T03). The strip is a native drag region via
  // -moz-window-dragging (see frame.css); buttons opt out. oncontrol
  // bubbles the window-control action (minimize/maximize/close) to the
  // shell, which dispatches through the Host API Windows module.
  let { title = "Astra", oncontrol = null } = $props();
  let mount;
  let api = $state(null);

  onMount(() => {
    const t = createTitlebar(mount.ownerDocument, {
      title,
      onControl: (action) => oncontrol?.(action),
    });
    mount.replaceWith(t.element);
    mount = t.element;
    api = t;
    return () => t.destroy();
  });

  export function setTitle(next) {
    api?.setTitle(next);
  }
</script>

<div class="astra-titlebar-mount" bind:this={mount}></div>
