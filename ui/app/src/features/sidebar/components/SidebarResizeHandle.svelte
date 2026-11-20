<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import {
    applyDragWidth,
    beginSidebarResize,
    cancelSidebarResize,
    finishSidebarResize,
    previewSidebarResize,
    publishSidebarResize,
    sidebarResizeActive,
    MAX_EXPANDED_WIDTH,
    MIN_EXPANDED_WIDTH,
  } from "$session/sidebar-mode.svelte";

  let { width, disabled = false }: { width: number; disabled?: boolean } = $props();
  let resizing = $state(false);
  let startX = 0;
  let startWidth = 0;
  let frame = 0;
  let previousCursor = "";

  // The page beside the column is native, so its edge is told where the
  // pointer is once per display frame; the column itself follows every move.
  function schedulePublish() {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!resizing || !sidebarResizeActive()) return;
      publishSidebarResize();
    });
  }
  function stopPublishing() {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  }
  function handlePointerDown(event: PointerEvent) {
    if (disabled || event.button !== 0) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    startWidth = width;
    target.focus();
    target.setPointerCapture(event.pointerId);
    // Held for the whole drag, over tab rows and pages alike.
    previousCursor = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    beginSidebarResize();
  }
  function handlePointerMove(event: PointerEvent) {
    if (!resizing || !sidebarResizeActive()) return;
    previewSidebarResize(startWidth + event.clientX - startX);
    schedulePublish();
  }
  function endPointerResize(event: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    stopPublishing();
    const target = event.currentTarget;
    if (target instanceof HTMLElement && target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
    document.body.style.cursor = previousCursor;
    finishSidebarResize(startWidth + event.clientX - startX);
  }
  function cancelPointerResize(event?: PointerEvent) {
    if (!resizing) return;
    resizing = false;
    stopPublishing();
    const target = event?.currentTarget;
    if (target instanceof HTMLElement && event && target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId);
    document.body.style.cursor = previousCursor;
    cancelSidebarResize();
  }
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && resizing) {
      event.preventDefault();
      cancelPointerResize();
      return;
    }
    if (disabled) return;
    const delta = event.shiftKey ? 24 : 8;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyDragWidth(width - delta);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyDragWidth(width + delta);
    } else if (event.key === "Home") {
      event.preventDefault();
      applyDragWidth(MIN_EXPANDED_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      applyDragWidth(MAX_EXPANDED_WIDTH);
    }
  }
</script>

<svelte:window onblur={() => cancelPointerResize()} onresize={() => cancelPointerResize()} />
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-label={m.ui_resize_sidebar()}
  aria-orientation="vertical"
  aria-valuemin={MIN_EXPANDED_WIDTH}
  aria-valuemax={MAX_EXPANDED_WIDTH}
  aria-valuenow={width}
  aria-valuetext={m.ui_sidebar_width({ width })}
  aria-disabled={disabled}
  tabindex={disabled ? -1 : 0}
  class="group absolute inset-y-0 -right-1.5 z-20 w-2 cursor-col-resize touch-none outline-none"
  onpointerdown={handlePointerDown}
  onpointermove={handlePointerMove}
  onpointerup={endPointerResize}
  onpointercancel={cancelPointerResize}
  onlostpointercapture={cancelPointerResize}
  onkeydown={handleKeydown}
>
  {#if !disabled}<span
      aria-hidden="true"
      class="group-hover:bg-text-muted absolute top-1/2 right-1.5 h-7 w-0.5 -translate-y-1/2 rounded-full bg-transparent group-focus-visible:bg-accent"
    ></span>{/if}
</div>
