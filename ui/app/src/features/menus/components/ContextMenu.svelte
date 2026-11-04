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

  /* The page menu is a menu, so it is drawn with the same recipe as every
     other menu in the product: 12px panel, 34px rows and the same insets.
     It stays solid (`--color-float`), like a Select's pop-up, because it
     floats over a web page the chrome cannot see through; the chrome's own
     menus are the only ones that can afford glass. In the paper theme
     `--color-float` is the same warm white, so the solid tier still reads as
     the same material. */
  .shell-menu {
    position: fixed;
    box-sizing: border-box;
    min-width: 216px;
    max-width: min(340px, calc(100vw - 16px));
    max-height: min(70vh, 560px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--menu-pad);
    border-radius: var(--radius-row);
    background: var(--color-float);
    color: var(--color-text);

    /* One rim and one soft drop, matching the shared menu surface. */
    box-shadow: var(--shadow-menu);
    outline: none;
    animation:
      shell-menu-fade var(--motion-fast) var(--ease-out),
      shell-menu-in var(--motion-base) var(--ease-out);
  }

  /* Own keyframes: the page menu loads on its own and cannot depend on the
     menu system's stylesheet having been reached first. Same numbers. */
  @keyframes shell-menu-fade {
    from {
      opacity: 0;
    }
  }

  @keyframes shell-menu-in {
    from {
      transform: scale(0.96) translateY(-4px);
    }
  }

  .shell-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: var(--menu-row);
    padding: 6px var(--menu-item-inset);
    border: 0;
    border-radius: var(--radius-inset);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--text-body);
    font-weight: 450;
    line-height: 18px;
    text-align: start;
    cursor: default;
    /* stylelint-disable-next-line property-no-vendor-prefix */
    -webkit-user-select: none;
    user-select: none;
    transition: background-color var(--motion-instant) var(--ease-smooth);
  }

  .shell-menu-item:disabled {
    color: var(--color-faint);
  }

  .shell-menu-item:focus-visible,
  .shell-menu-item:hover:not(:disabled) {
    background: var(--row-hover);
    outline: none;
  }

  .shell-menu-item:active:not(:disabled) {
    background: var(--row-pressed);
  }

  .shell-menu-item[data-danger] {
    color: var(--color-danger);
  }

  /* An unavailable row is quiet even when it is destructive: the action cannot
     be taken, so its colour must not read as available. */
  .shell-menu-item[data-danger]:disabled {
    color: var(--color-faint);
  }

  .shell-menu-item[data-danger]:focus-visible,
  .shell-menu-item[data-danger]:hover:not(:disabled) {
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
  }

  .shell-menu-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 16px;
    height: 16px;
    color: var(--color-muted);
  }

  .shell-menu-item:disabled .shell-menu-icon {
    color: var(--color-faint);
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
    padding-inline-start: 28px;
    color: var(--color-faint);
    font-size: var(--text-caption);
    font-variant-numeric: tabular-nums;
  }

  .shell-menu-item:hover .shell-menu-hint,
  .shell-menu-item:focus-visible .shell-menu-hint {
    color: var(--color-muted);
  }

  /* Full bleed: a divider that stops short of the edge reads as a misaligned
     row rather than as a break in the list. */
  .shell-menu-separator {
    height: 1px;
    margin: 4px calc(var(--menu-pad) * -1);
    background: var(--color-menu-separator);
  }

  .shell-menu-heading {
    padding: 10px var(--menu-item-inset) 5px;
    color: var(--color-faint);
    font-size: var(--text-caption);
    font-weight: 550;
    line-height: 14px;
    letter-spacing: 0.01em;
  }

  /* The first heading has no list above it; the panel's own padding is the
     whole inset it needs. */
  .shell-menu-heading:first-child {
    padding-block-start: 4px;
  }

  @media (prefers-reduced-motion: reduce) {
    .shell-menu {
      animation: shell-menu-fade var(--motion-instant) linear;
    }
  }

  @media (forced-colors: active) {
    .shell-menu {
      border: 1px solid CanvasText;
      box-shadow: none;
    }

    .shell-menu-item:focus-visible,
    .shell-menu-item:hover:not(:disabled) {
      background: Highlight;
      color: HighlightText;
    }
  }
</style>
