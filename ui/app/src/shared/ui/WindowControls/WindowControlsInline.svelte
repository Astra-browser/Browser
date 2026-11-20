<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import { maximized, windowAction } from "$shared/lib/window-control";

  // The window's own controls, in the page bar's trailing end. The bar is the
  // horizontal top panel (nav, the long address field, then these), so the
  // trio is part of the chrome instead of a capsule floating over the page.
  // When the bar is away, the top-edge strip brings it back and they come with
  // it; the glyphs are the conventional ones rather than decorative icons.

  let isMaximized = $state(maximized());

  function act(action: "minimize" | "maximize" | "restore" | "close") {
    if (action === "maximize" || action === "restore") isMaximized = action === "maximize";
    windowAction(action);
  }
</script>

<div class="window-controls-inline" role="group" aria-label={m.ui_window_controls()}>
  <button
    type="button"
    class="window-control"
    aria-label={m.ui_minimize()}
    title={m.ui_minimize()}
    onclick={() => act("minimize")}
  >
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2 5h6" />
    </svg>
  </button>
  <button
    type="button"
    class="window-control"
    aria-label={isMaximized ? m.ui_restore() : m.ui_maximize()}
    title={isMaximized ? m.ui_restore() : m.ui_maximize()}
    onclick={() => act(isMaximized ? "restore" : "maximize")}
  >
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {#if isMaximized}
        <rect x="1.7" y="3.7" width="4.6" height="4.6" rx="0.9" />
        <path d="M3.9 3.5V2.6a1 1 0 0 1 1-1h2.5a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-.9" />
      {:else}
        <rect x="2.1" y="2.1" width="5.8" height="5.8" rx="1" />
      {/if}
    </svg>
  </button>
  <button
    type="button"
    class="window-control window-control-close"
    aria-label={m.ui_close()}
    title={m.ui_close()}
    onclick={() => act("close")}
  >
    <svg viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" />
    </svg>
  </button>
</div>

<style>
  .window-controls-inline {
    display: flex;
    flex: none;
    align-items: center;
    gap: 1px;
    margin-inline-start: 2px;
  }

  .window-control {
    display: grid;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--color-label-secondary);
    cursor: default;
    outline: none;
    transition:
      background-color var(--motion-instant) var(--ease-smooth),
      color var(--motion-instant) var(--ease-smooth),
      scale var(--motion-fast) var(--ease-spring);
  }

  .window-control svg {
    inline-size: 10px;
    block-size: 10px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 1.1;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .window-control:hover {
    background: var(--row-hover);
    color: var(--color-text);
  }

  .window-control:active {
    scale: 0.92;
    background: var(--row-pressed);
  }

  .window-control:focus-visible {
    box-shadow: var(--shadow-field-focus);
  }

  /* Closing is the one that ends the window, so it is the one that turns red. */
  .window-control-close:hover {
    background: var(--row-hover);
    color: var(--color-danger);
  }

  @media (prefers-reduced-motion: reduce) {
    .window-control {
      transition: none;
    }
  }
</style>
