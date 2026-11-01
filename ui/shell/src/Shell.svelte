<script>
  import { onMount } from "svelte";
  import Hello from "./Hello.svelte";
  import { loadHost, newRequestId } from "./host.js";
  import { mountUrlBar } from "./urlbar.js";
  import "./urlbar.css";

  // P1-T10 shell: minimal URL bar (imperative XHTML DOM — Svelte templates
  // cannot carry <button>/<form>/<input> in a chrome XUL document, the
  // sanitizer strips them) driving navigation through the Host API stub,
  // one live content slot, and the P1-T08 hello (kept rendered so the
  // P1-T08 contract — "Hello Tab" text in #astra-root — stays green).
  let barMount;
  let slot;
  let slotError = $state("");

  onMount(async () => {
    const host = await loadHost();
    if (!host) {
      slotError = "Host API unavailable outside the browser window";
      return;
    }
    const bar = mountUrlBar(barMount, host);
    try {
      const win = barMount.ownerDocument.defaultView;
      if (win && !win.__astraHost) {
        // P1-T10 test seam for the Marionette contract test (tests/contract/
        // content_slot.py): exposes the window's Host API instance. Chrome
        // code already has these capabilities; this adds none.
        win.__astraHost = {
          Tabs: host.Tabs,
          Navigation: host.Navigation,
          Panes: host.Panes,
          addEventListener: host.addEventListener,
        };
      }
    } catch {
      // Non-browser preview: no window to attach to.
    }
    if (!host.Content) {
      slotError = "content binding unavailable";
      return;
    }
    let mounted = null;
    try {
      mounted = await host.Content.mount(slot, { request_id: newRequestId() });
    } catch (e) {
      slotError = String(e?.message ?? e);
      return;
    }
    return () => {
      mounted?.detach();
      bar.destroy();
    };
  });
</script>

<div class="astra-shell">
  <div class="astra-bar-mount" bind:this={barMount}></div>
  <div class="astra-content" data-astra-content="" bind:this={slot}>
    {#if slotError}
      <p class="slot-error">{slotError}</p>
    {/if}
  </div>
  <details class="astra-about">
    <summary>Shell status</summary>
    <Hello />
  </details>
</div>

<style>
  .astra-shell {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: #1c1b22;
    color: #fbfbfe;
  }
  .astra-bar-mount {
    display: flex;
    flex-direction: column;
  }
  .astra-bar-mount > :global(.astra-urlbar) {
    display: flex;
  }
  .astra-content {
    flex: 1 1 auto;
    min-height: 200px;
    display: flex;
    flex-direction: column;
    background: #fff;
  }
  .astra-content > :global([data-astra-browser]) {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
  }
  .slot-error {
    font-family: system-ui, sans-serif;
    padding: 1rem;
    color: #1c1b22;
  }
  .astra-about {
    font-family: system-ui, sans-serif;
    font-size: 0.8rem;
    border-top: 1px solid #52525e;
    background: #2b2a33;
    color: #cfcfd8;
  }
  .astra-about summary {
    cursor: pointer;
    padding: 0.3rem 0.75rem;
  }
</style>
