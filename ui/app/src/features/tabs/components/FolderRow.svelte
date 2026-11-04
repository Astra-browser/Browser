<script lang="ts">
  import { Folder01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
  import Icon from "$shared/ui/Icon";
  let {
    name,
    depth,
    expanded = true,
    ontoggle,
    motionKey,
    class: className = "",
  }: {
    motionKey?: string;
    name: string;
    depth: number;
    expanded?: boolean;
    ontoggle?: () => void;
    class?: string;
  } = $props();

  let steps = $derived(Math.min(depth, 8) * 13);
</script>

<li class={className} data-motion-key={motionKey}>
  <button
    type="button"
    class="folder-row"
    style:padding-inline-start={`calc(var(--tab-inset, 8px) + ${steps}px)`}
    aria-expanded={expanded}
    onclick={ontoggle}
    ><Icon icon={Folder01Icon} size={15} /><span>{name}</span><span
      class="folder-chevron"
      data-expanded={expanded}><Icon icon={ArrowRight01Icon} size={12} /></span
    ></button
  >
</li>

<style>
  /* The folder row is a tab row with a disclosure instead of a site mark.
     The element selector outranks the shell's legacy `.folder-row` rule. */
  button.folder-row {
    display: flex;
    align-items: center;
    gap: var(--tab-inset);
    inline-size: 100%;
    block-size: var(--row-tab);
    padding-inline-end: var(--tab-inset);
    border: 0;
    border-radius: var(--radius-tab);
    background: transparent;
    color: var(--color-label-secondary);
    font: inherit;
    font-size: var(--sidebar-row-text);
    font-weight: var(--sidebar-row-weight);
    letter-spacing: -0.005em;
    text-align: start;
    cursor: default;
    transition:
      background-color var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out);
  }

  button.folder-row:hover {
    background: var(--row-hover);
    color: var(--color-text);
  }

  button.folder-row:focus-visible {
    outline: none;
    box-shadow: var(--row-rim);
  }

  .folder-chevron {
    flex: none;
    color: var(--color-faint);
  }
</style>
