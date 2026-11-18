<script lang="ts">
  import { Cancel01Icon } from "@hugeicons/core-free-icons";
  import type { TabView } from "$shared/ipc/bindings";
  import { favicons } from "$domain/favicons";
  import Icon from "$shared/ui/Icon";
  import FavIcon from "$shared/ui/FavIcon";
  import * as m from "$shared/i18n/messages";
  import TabRow from "./TabRow.svelte";
  import { tabFallbackIcon } from "../lib/tab-icon";

  // A browser page that stands in the tab list as its own tab. It is not a
  // native tab, so it has none of a page tab's drag, split or menu actions;
  // it can be chosen and closed.
  let {
    tab,
    active,
    compact = false,
    onSelect,
    onClose,
  }: {
    tab: TabView;
    active: boolean;
    compact?: boolean;
    onSelect: () => void;
    onClose: () => void;
  } = $props();

  let fallback = $derived(tabFallbackIcon(tab.content));
</script>

{#if compact}
  <div
    class="page-tab-rail"
    data-page-tab={tab.id}
    data-astra-tab-id={tab.id}
    data-astra-tab-url=""
    data-astra-projection-revision={tab.projection_revision}
  >
    <button
      type="button"
      class="rail-item"
      title={tab.title}
      aria-current={active ? "page" : undefined}
      aria-label={tab.title}
      onclick={onSelect}
    >
      <FavIcon
        image={favicons.image(tab.icon)}
        tone={favicons.tone(tab.icon)}
        size={16}
        lit={active}
        {fallback}
      />
      <span data-astra-tab-label class="sr-only">{tab.title}</span>
    </button>
    <button
      type="button"
      class="rail-close"
      title={m.close_tab()}
      aria-label={m.close_named_tab({ title: tab.title })}
      onclick={onClose}><Icon icon={Cancel01Icon} size={8} strokeWidth={2.4} /></button
    >
  </div>
{:else}
  <ul class="page-tab-list" role="list" aria-label={m.open_tabs()}>
    <TabRow
      {tab}
      {active}
      closable
      splitCandidate={false}
      {onSelect}
      {onClose}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={() => {}}
      onPointerMove={() => {}}
      onPointerUp={() => {}}
      onPointerCancel={() => {}}
    />
  </ul>
{/if}

<style>
  .page-tab-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .page-tab-rail {
    position: relative;
    display: flex;
    justify-content: center;
    padding-block-end: var(--tab-gap);
  }

  .rail-item {
    display: grid;
    place-items: center;
    width: var(--row-tab);
    height: var(--row-tab);
    border: 0;
    border-radius: var(--radius-tab);
    background: transparent;
    color: var(--color-faint);
    cursor: default;
    transition:
      background-color var(--motion-fast) var(--ease-out),
      box-shadow var(--motion-fast) var(--ease-out),
      color var(--motion-fast) var(--ease-out),
      scale var(--motion-slow) var(--ease-spring);
  }

  .rail-item:hover {
    background: var(--row-hover);
    color: var(--color-label-secondary);
  }

  .rail-item:active {
    scale: 0.94;
    transition-duration: var(--motion-instant);
  }

  .rail-item[aria-current="page"] {
    background: color-mix(in srgb, var(--color-accent) 14%, var(--row-active));
    box-shadow: var(--row-rim);
  }

  .rail-close {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 4px;
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-capsule);
    background: var(--color-float);
    box-shadow: var(--shadow-badge);
    color: var(--color-muted);
    opacity: 0;
    scale: 0.6;
    pointer-events: none;
    cursor: default;
    transition:
      opacity var(--motion-fast) var(--ease-out),
      scale var(--motion-base) var(--ease-spring),
      color var(--motion-instant) var(--ease-out);
  }

  .rail-close:focus-visible {
    opacity: 1;
    scale: 1;
    pointer-events: auto;
  }

  .rail-close:hover {
    color: var(--color-text);
  }

  .page-tab-rail:hover .rail-close {
    opacity: 1;
    scale: 1;
    pointer-events: auto;
    transition-delay: 160ms, 160ms, 0ms;
  }

  .page-tab-rail:hover .rail-close:active {
    scale: 0.9;
  }

  @media (prefers-reduced-motion: reduce) {
    .rail-item,
    .rail-close {
      transition: none;
    }
  }
</style>
