<script lang="ts">
  import Icon from "$shared/ui/Icon/Icon.svelte";
  import { tick } from "svelte";
  import { choose, close, current } from "../lib/menu-store.svelte";

  const EDGE = 8;
  let panel = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);

  // The chrome sends viewport coordinates. Keep the panel inside the window
  // even when the press happened at the last pixel, then focus the first row so
  // the keyboard works without a second click.
  $effect(() => {
    const menu = current();
    if (!menu || !panel) return;
    left = Math.max(EDGE, Math.min(menu.x, window.innerWidth - (panel.offsetWidth || 240) - EDGE));
    top = Math.max(EDGE, Math.min(menu.y, window.innerHeight - (panel.offsetHeight || 200) - EDGE));
    void tick().then(() => {
      panel?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    });
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }
    const rows = [
      ...(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : event.key === "ArrowDown"
            ? (at + 1) % rows.length
            : (at - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  }
</script>

{#if current()}
  {@const menu = current()!}
  <div
    class="menu-backdrop"
    role="presentation"
    onpointerdown={(event) => {
      if (event.target === event.currentTarget) close();
    }}
    oncontextmenu={(event) => event.preventDefault()}
  >
    <div
      bind:this={panel}
      class="shell-menu"
      role="menu"
      tabindex="-1"
      style:left={`${left}px`}
      style:top={`${top}px`}
      onkeydown={onKeydown}
    >
      {#each menu.items as entry, index (index)}
        {#if entry.kind === "separator"}
          <div class="shell-menu-separator" role="separator"></div>
        {:else if entry.kind === "heading"}
          <div class="shell-menu-heading" role="presentation">{entry.label}</div>
        {:else}
          <button
            type="button"
            class="shell-menu-item"
            role="menuitem"
            disabled={entry.disabled}
            data-danger={entry.danger || undefined}
            onclick={() => choose(entry.id)}
          >
            <span class="shell-menu-icon" aria-hidden="true">
              {#if entry.icon}<Icon icon={entry.icon} size={15} />{/if}
            </span>
            <span class="shell-menu-label">{entry.label}</span>
            {#if entry.hint}<span class="shell-menu-hint" aria-hidden="true">{entry.hint}</span
              >{/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
  }

  .shell-menu {
    position: fixed;
    min-width: 220px;
    max-width: min(320px, calc(100vw - 16px));
    max-height: min(70vh, 560px);
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-card);
    background: var(--color-surface);
    color: var(--color-text);
    box-shadow: var(--shadow-overlay);
    outline: none;
  }

  .shell-menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 30px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--text-sm);
    text-align: start;
    cursor: default;
  }

  .shell-menu-item:disabled {
    opacity: 0.45;
  }

  .shell-menu-item:focus-visible {
    background: var(--color-fill);
    outline: none;
  }

  .shell-menu-item:hover:not(:disabled) {
    background: var(--color-fill);
    outline: none;
  }

  .shell-menu-item[data-danger] {
    color: var(--color-danger);
  }

  .shell-menu-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 16px;
    height: 16px;
  }

  .shell-menu-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shell-menu-hint {
    flex: none;
    margin-inline-start: auto;
    padding-inline-start: 12px;
    color: var(--color-text-faint);
    font-size: var(--text-xs);
  }

  .shell-menu-separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--color-border);
  }

  .shell-menu-heading {
    padding: 6px 8px 2px;
    color: var(--color-text-faint);
    font-size: var(--text-xs);
    font-weight: 600;
  }
</style>
