<script lang="ts" module>
  export type LauncherAction = { id: string; label: string; keys: string[]; run: () => void };
  /** The sheet's id, which the field names while the sheet is open. */
  export const ACTIONS_ID = "launcher-actions";
</script>

<script lang="ts">
  import * as m from "$shared/i18n/messages";
  import KeyHint from "$shared/ui/KeyHint";

  let {
    actions,
    height = $bindable(0),
    onhighlight,
    onrun,
    onclose,
  }: {
    actions: LauncherAction[];
    height?: number;
    /** The highlighted item's id, for the field's `aria-activedescendant`. */
    onhighlight: (id: string | undefined) => void;
    onrun: (action: LauncherAction) => void;
    onclose: () => void;
  } = $props();

  let index = $state(0);
  let sheet = $state<HTMLElement>();
  const itemId = (action: LauncherAction) => `${ACTIONS_ID}-${action.id}`;

  $effect(() => {
    const action = actions[Math.min(index, actions.length - 1)];
    onhighlight(action ? itemId(action) : undefined);
  });

  // The field keeps focus throughout, so the sheet reads keys from the window
  // rather than taking focus and handing it back.
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || !actions.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      index = Math.min(actions.length - 1, Math.max(0, index + step));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = actions[Math.min(index, actions.length - 1)];
      if (action) onrun(action);
    }
  }

  function pointerdown(event: PointerEvent) {
    const target = event.target as Element | null;
    if (!sheet?.contains(target) && !target?.closest('button[aria-haspopup="menu"]')) onclose();
  }
</script>

<svelte:window onkeydown={keydown} onpointerdown={pointerdown} />

<div
  id={ACTIONS_ID}
  class="sheet"
  role="menu"
  aria-label={m.launcher_actions()}
  bind:this={sheet}
  bind:offsetHeight={height}
>
  {#each actions as action, i (action.id)}
    <button
      type="button"
      id={itemId(action)}
      role="menuitem"
      tabindex="-1"
      class:active={i === index}
      onpointermove={() => (index = i)}
      onpointerdown={(event) => event.preventDefault()}
      onclick={() => onrun(action)}
      ><span>{action.label}</span><KeyHint keys={action.keys} /></button
    >
  {/each}
</div>

<style>
  /* The launcher's action sheet is a menu, so it takes the menu's own
     geometry and solid material: the same 22px panel, 34px rows and insets
     as the chrome's dropdowns, which it is usually mistaken for. */
  .sheet {
    position: absolute;
    inset-block-end: 48px;
    inset-inline-end: 10px;
    z-index: 1;
    display: flex;
    flex-direction: column;
    min-width: 248px;
    max-width: min(340px, calc(100vw - 24px));
    box-sizing: border-box;
    padding: var(--menu-pad);
    border-radius: var(--radius-menu);
    background: var(--color-float);
    box-shadow: var(--shadow-menu), var(--shine-top);
    transform-origin: bottom right;
    animation: sheet-in var(--motion-fast) var(--ease-out);
    overflow: hidden;
  }

  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-height: var(--menu-row);
    padding: 6px var(--menu-item-inset);
    border: 0;
    border-radius: calc(var(--radius-menu) - var(--menu-pad));
    background: transparent;
    color: var(--color-text);
    font-size: var(--text-body);
    font-weight: 450;
    text-align: start;
  }

  button.active {
    background: var(--row-active);
  }

  button:active {
    background: var(--row-pressed);
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(4px) scale(0.98);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  @media (forced-colors: active) {
    .sheet {
      border-color: CanvasText;
    }

    button.active {
      outline: 1px solid Highlight;
    }
  }
</style>
