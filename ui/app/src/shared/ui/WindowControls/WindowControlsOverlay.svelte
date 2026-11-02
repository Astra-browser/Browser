<script lang="ts">
  import { onMount } from "svelte";
  import * as m from "$shared/i18n/messages";
  import { maximized, windowAction } from "$shared/lib/window-control";

  /**
   * The window's own controls, kept out of the chrome until they are wanted.
   *
   * The product draws the whole window, so a permanent minimise/maximise/close
   * trio is one more thing that belongs to the system rather than to browsing.
   * They come out only when the pointer reaches the top-right corner, the place
   * every desktop already teaches, and they stay out of the way of what is
   * underneath: the reveal is measured from pointer position, not from an
   * invisible box lying over the page, so nothing below loses a hover or a
   * click. The keyboard reaches them the ordinary way, and focus holds them
   * open.
   *
   * The glyphs are drawn here rather than taken from the icon set: at this size
   * a titlebar wants the conventional square and overlapping squares, not a
   * decorative mark that reads as a squiggle.
   */

  /** How far in from the window's right edge the corner starts. */
  const REACH = 132;
  /** How far down from the top edge it reaches. */
  const DEPTH = 44;

  let shown = $state(false);
  let root = $state<HTMLElement>();
  let isMaximized = $state(false);

  onMount(() => {
    const near = (x: number, y: number) => x >= window.innerWidth - REACH && y <= DEPTH;
    const move = (event: PointerEvent) => {
      // A touch has no hover; the buttons are reached by tapping them instead.
      if (event.pointerType === "touch") return;
      const inside = near(event.clientX, event.clientY);
      if (inside && !shown) isMaximized = maximized();
      shown = inside || root?.matches(":focus-within") === true;
    };
    const hide = () => {
      shown = false;
    };
    // Leaving the window is not hovering the corner any more.
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget === null) shown = false;
    };
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerout", leave, { passive: true });
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerout", leave);
      window.removeEventListener("blur", hide);
    };
  });

  function act(action: "minimize" | "maximize" | "restore" | "close") {
    if (action === "maximize" || action === "restore") isMaximized = action === "maximize";
    windowAction(action);
  }
</script>

<!--
  A group of three, named for the keyboard, floating on its own material so it
  reads over whatever the corner holds. Hidden means hidden to the pointer too:
  the cluster never eats a hover from the address bar's own controls.
-->
<div
  bind:this={root}
  class="window-controls"
  data-shown={shown}
  role="group"
  aria-label={m.ui_window_controls()}
>
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
  .window-controls {
    position: fixed;
    inset-block-start: 7px;
    inset-inline-end: 7px;
    z-index: 60;
    display: flex;
    gap: 2px;
    padding: 4px;
    border-radius: var(--radius-capsule);
    background: var(--color-menu);
    backdrop-filter: blur(24px);
    box-shadow: var(--shadow-menu), var(--shine-top);
    opacity: 0;
    translate: 0 -4px;
    pointer-events: none;
    transition:
      opacity var(--motion-base) var(--ease-out),
      translate var(--motion-base) var(--ease-out);
  }

  /* Focus is a request to see them, exactly as the pointer is. */
  .window-controls[data-shown="true"],
  .window-controls:focus-within {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }

  .window-control {
    display: grid;
    place-items: center;
    inline-size: 26px;
    block-size: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-capsule);
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
    .window-controls,
    .window-control {
      transition: none;
    }
  }

  @media (forced-colors: active) {
    .window-controls {
      border: 1px solid CanvasText;
    }
  }
</style>
