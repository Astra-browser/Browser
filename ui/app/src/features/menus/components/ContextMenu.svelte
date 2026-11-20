<script lang="ts">
  import Icon from "$shared/ui/Icon/Icon.svelte";
  import { tick } from "svelte";
  import { choose, close, current } from "../lib/menu-store.svelte";

  const EDGE = 8;
  let panel = $state<HTMLDivElement | null>(null);
  let left = $state(0);
  let top = $state(0);
  // What held the keyboard when the menu opened. A menu takes it away, so it
  // must give it back — otherwise closing leaves the person on <body> with
  // nothing to press and no way to tell where they are.
  let opener: HTMLElement | null = null;
  let open = $derived(current() !== null);

  const rows = () => [
    ...(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []),
  ];

  /**
   * Gives the keyboard back to the opener. `force` is for a close the menu
   * commanded itself (Escape); otherwise an action that put the keyboard
   * somewhere of its own (a field it opened, another surface) keeps it, and
   * only a menu that strands it on <body> hands it back.
   */
  function restoreFocus(force: boolean) {
    const target = opener;
    opener = null;
    if (!target || !target.isConnected) return;
    const active = document.activeElement;
    if (!force && active !== null && active !== document.body) return;
    target.focus({ preventScroll: true });
  }

  function dismiss(force: boolean) {
    if (!open) return;
    close();
    restoreFocus(force);
  }

  function dismissWithChoice(id: string) {
    choose(id);
    // `choose` closes and runs the action; a row that moved focus itself is
    // left alone, one that did not gives the keyboard back.
    restoreFocus(false);
  }

  // The chrome sends viewport coordinates. Keep the panel inside the window
  // even when the press happened at the last pixel, then focus the first row so
  // the keyboard works without a second click.
  $effect(() => {
    const menu = current();
    if (!menu || !panel) return;
    if (opener === null) {
      const active = document.activeElement;
      opener = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    left = Math.max(EDGE, Math.min(menu.x, window.innerWidth - (panel.offsetWidth || 240) - EDGE));
    top = Math.max(EDGE, Math.min(menu.y, window.innerHeight - (panel.offsetHeight || 200) - EDGE));
    void tick().then(() => {
      panel?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    });
  });

  // The panel is not the only place keys land. Escape, the arrows and Tab are
  // heard while the menu is up wherever the focus went (a row, the panel, a
  // control inside it), and Tab wraps inside the layer instead of walking out
  // to the window controls behind it.
  $effect(() => {
    if (!open) return;
    window.addEventListener("keydown", onKeydown, true);
    // Focus that left the layer for something else (a shortcut, a press on
    // another surface) closes the menu with it: a menu left open over a column
    // that no longer owns the keyboard reads as a frozen window.
    window.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("focusin", onFocusIn);
    };
  });

  function onFocusIn(event: FocusEvent) {
    const target = event.target;
    if (target instanceof Node && panel?.contains(target)) return;
    dismiss(false);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      // The app's own shortcut layer is on the same key: a menu that is up
      // owns Escape, and nothing behind it may act on the same press.
      event.stopPropagation();
      dismiss(true);
      return;
    }
    const list = rows();
    if (event.key === "Tab") {
      if (list.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const at = list.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.shiftKey ? -1 : 1;
      const next =
        at === -1
          ? event.shiftKey
            ? list.length - 1
            : 0
          : (at + step + list.length) % list.length;
      list[next]?.focus();
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
    if (list.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? list.length - 1
          : event.key === "ArrowDown"
            ? (at + 1) % list.length
            : (at - 1 + list.length) % list.length;
    list[next]?.focus();
  }
</script>

{#if current()}
  {@const menu = current()!}
  <div
    class="menu-backdrop"
    role="presentation"
    onpointerdown={(event) => {
      if (event.target === event.currentTarget) dismiss(false);
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
            onclick={() => dismissWithChoice(entry.id)}
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

  /* The pointer gets a quiet wash: a row under the cursor is obvious because
     the cursor is on it. The keyboard has no such pointer, so its row also
     carries the product's focus ring inside the plate — the same 1.5px ring
     every other keyboard stop gets — and the wash goes up one step. A 4% wash
     alone measured 1.1:1 against the panel, which is not a highlight. */
  .shell-menu-item:focus-visible {
    background: var(--row-pressed);
    box-shadow: inset 0 0 0 1.5px var(--color-ring);
    outline: none;
  }

  .shell-menu-item:hover:not(:disabled, :focus-visible) {
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

  .shell-menu-item[data-danger]:focus-visible {
    background: color-mix(in srgb, var(--color-danger) 22%, transparent);
    box-shadow: inset 0 0 0 1.5px var(--color-danger);
  }

  .shell-menu-item[data-danger]:hover:not(:disabled, :focus-visible) {
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

    .shell-menu-item {
      transition: none;
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
      box-shadow: none;
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
